#!/bin/bash
PW=$(cat /tmp/oc-pw.txt)
SID="$1"
curl -sS -u "opencode:$PW" "http://127.0.0.1:4096/api/session/$SID/message" | node /tmp/dump-msgs.mjs
