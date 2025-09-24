#!/bin/bash

cd frontend
bun run build
cd ..

uv run modal deploy main.py
