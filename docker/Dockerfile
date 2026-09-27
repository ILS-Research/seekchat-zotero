# Build image for SeekChat. Everything needed to build, test and pack the
# plugin lives here, so the host needs nothing but Docker.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends zip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
