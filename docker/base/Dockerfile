# Shared image for the harness, the bake steps and every renderer that
# does not need its own toolchain. An example that needs something else
# (zig, a newer rustc, ...) declares its own image in spec.json.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      build-essential \
      rustc cargo \
      chromium \
      libvulkan1 libegl1 libgles2 libegl-dev libgles-dev libx11-dev \
      gdal-bin \
      osmium-tool \
      procps \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
