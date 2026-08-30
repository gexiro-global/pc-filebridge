# Third-party notices

The VPS image contains two upstream executables:

- OpenAI tunnel-client v0.0.13, commit 4b5267f823be0b046bb883aacb51603cfde3a0ea, licensed under Apache-2.0. PC FileBridge reproducibly rebuilds this exact source revision with security-only dependency updates: OpenTelemetry Go v1.44.0 and golang.org/x/net v0.56.0.
- Cloudflare cloudflared, copied unchanged from the digest-pinned official OpenAI tunnel-client v0.0.13 image, licensed under Apache-2.0.

Upstream source and license information:

- https://github.com/openai/tunnel-client
- https://github.com/cloudflare/cloudflared

The Apache License 2.0 text is installed beside this notice in the runtime image.
