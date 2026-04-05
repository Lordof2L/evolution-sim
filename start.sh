#!/bin/bash
cd "$(dirname "$0")"
npm install 2>/dev/null
node server.js
