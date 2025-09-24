from fastapi import FastAPI, UploadFile, HTTPException, File
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from datetime import datetime, timedelta
from contextlib import suppress
from pydantic import BaseModel
from pathlib import Path
from uuid import uuid4

import formalpdf
import modal
import os
import re


class Split(BaseModel):
    documentId: str
    split: str


def parse_split(split: str) -> list[tuple[int, int]]:
    """
    a sort of robust regex parser for ranges like:
        19-20, 21, 22-25
     => [(19, 20), (21, 21), (22, 25)

    Note that the output ranges are INCLUSIVE and ASSUMED TO BE ONE-INDEXED,
    which needs to be accounted for when actually performing the split
    """
    matches = re.findall(r"(\d+)\s*[-]?\s*(\d+)?", split)
    ranges = []
    for match in matches:
        start = int(match[0])
        end = int(match[1]) if match[1] else start
        ranges.append((start, end))

    return ranges


def split_pdf(splits: list[Split], base_dir: Path, output_path: Path | str):
    out = formalpdf.open()

    for split in splits:
        din = formalpdf.open(base_dir / f"{split.documentId}.pdf")
        for from_page, to_page in parse_split(split.split):
            out.insert_pdf(
                din,
                # account for the one-indexing
                from_page=from_page - 1,
                # account for the inclusivity
                to_page=to_page,
            )

    out.save(output_path)


MAX_BYTES = 100 * 1024 * 1024  # 100MB
CHUNK_SIZE = 1 * 1024 * 1024  # 1MB


def pdf_header_exists(chunk: bytes) -> bool:
    i = chunk.lstrip().find(b"%PDF-")
    return i == 0


async def stream_save_pdf(
    file: UploadFile, destination: Path
) -> tuple[int, int | None]:
    temp_path = destination.with_suffix(destination.suffix + ".part")
    total = 0
    header_buffer = bytearray()

    try:
        out = open(temp_path, "wb", buffering=CHUNK_SIZE)
        while chunk := await file.read(CHUNK_SIZE):
            if len(header_buffer) < 5:
                need = max(0, 1024 - len(header_buffer))
                header_buffer.extend(chunk[:need])

                if len(header_buffer) >= 5 and not pdf_header_exists(header_buffer):
                    raise HTTPException(400)

            total += len(chunk)

            if total > MAX_BYTES:
                raise HTTPException(400, "PDF exceeds 100 MB limit")

            out.write(chunk)

        if total == 0:
            raise HTTPException(400, "Empty upload")
        out.close()

        os.replace(temp_path, destination)

    except Exception as e:
        with suppress(FileNotFoundError):
            os.remove(temp_path)
        raise e

    return total, None


class SplitRequest(BaseModel):
    filename: str
    documents: list[Split]


class DocumentResponse(BaseModel):
    documentId: str
    pages: int
    size: int


DATA_PATH = Path("/data")

image = modal.Image.debian_slim().uv_pip_install(
    "formalpdf==0.1.5", "fastapi[standard]", "python-multipart", "pydantic"
).add_local_dir("./dist", "/root/dist")
app = modal.App(name="splitter", image=image)
volume = modal.Volume.from_name("splitter", create_if_missing=True)


@app.function(volumes={str(DATA_PATH): volume})
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def splitter_app():
    web_app = FastAPI()

    origins = [
        "http://localhost:5173"
    ]

    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    

    @web_app.post("/upload")
    async def upload(file: UploadFile = File(...)):
        document_id = str(uuid4())
        input_dir = DATA_PATH / "inputs"
        input_dir.mkdir(exist_ok=True, parents=True)
        input_path = input_dir / f"{document_id}.pdf"
        size, _ = await stream_save_pdf(file, input_path)

        document = formalpdf.open(input_path)

        return DocumentResponse(documentId=document_id, pages=len(document), size=size)


    @web_app.post("/split")
    async def split(request: SplitRequest) -> FileResponse:
        input_dir = DATA_PATH / "inputs"
        input_dir.mkdir(exist_ok=True, parents=True)

        output_dir = DATA_PATH / "outputs"
        output_dir.mkdir(exist_ok=True, parents=True)
        output_path = output_dir / f"{str(uuid4())}.pdf"

        split_pdf(request.documents, input_dir, output_path) 

        return FileResponse(
            str(output_path),
            media_type="application/pdf",
            filename=request.filename,
        )

    # Mount built frontend at root
    web_app.mount(
        "/",
        StaticFiles(directory=Path(__file__).parent / "dist", html=True),
        name="static",
    )

    return web_app


@app.function(
    schedule=modal.Period(hours=4),
    volumes={str(DATA_PATH): volume}
)
def clear_pdfs():
    cutoff_ts = (datetime.now() - timedelta(days=1)).timestamp()
    """
    On a regularly scheduled time, go through and delete all old PDFs.
    """
    for folder in ("inputs", "outputs"):
        dir_path = DATA_PATH / folder
        if not dir_path.exists():
            continue

        for pdf_path in dir_path.glob("*.pdf"):
            with suppress(FileNotFoundError):
                # Delete if last modification is older than cutoff
                if pdf_path.stat().st_mtime < cutoff_ts:
                    pdf_path.unlink()
