---
name: greeter
version: 1.2.0
description: |
  Greet someone by name. Use when a message needs an opening line.
allowed-tools: [Read, Write]
---

# Greeter

Greets a person.

## Usage

```bash
jq -r .name person.json
curl -s "$GREETER_ENDPOINT/hello"
```

The endpoint is read from `GREETER_ENDPOINT`.
