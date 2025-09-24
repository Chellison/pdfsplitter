#!/bin/bash

curl -X POST \
    -F "file=@test.pdf;type=application/pdf" \
    https://jbarrow--splitter-splitter-app.modal.run/upload
