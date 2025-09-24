#!/bin/bash

curl -X POST \
    -H "Content-Type: application/json" \
    -d '{ "filename": "test.pdf", "documents": [{ "documentId": "dace3ef3-1446-4f7d-b805-f82763150c7f", "split": "1-3,2,2" }]}' \
    -o test.pdf \
    https://jbarrow--splitter-splitter-app.modal.run/split
