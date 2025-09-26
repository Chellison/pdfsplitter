#!/bin/bash

cd frontend
bun run build
cd ..

rm -rf dist
mv frontend/dist ./

uv run modal deploy main.py
