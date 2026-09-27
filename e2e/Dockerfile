# E2E image: a real Zotero under Xvfb (virtual X server, no display needed),
# plus Node for the mock LLM server and the fixture PDF.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils bzip2 xvfb xauth \
      libgtk-3-0 libegl1 libdbus-glib-1-2 libasound2 libx11-xcb1 libxtst6 libpci3 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

ARG ZOTERO_VERSION=10.0.3
RUN curl -fsSL "https://download.zotero.org/client/release/${ZOTERO_VERSION}/Zotero-${ZOTERO_VERSION}_linux-x86_64.tar.xz" \
      | tar -xJ -C /opt \
 && mv /opt/Zotero_linux-x86_64 /opt/zotero

COPY make-pdf.mjs mock-llm.mjs run-in-container.sh /e2e/
RUN node /e2e/make-pdf.mjs /fixtures && chmod +x /e2e/run-in-container.sh

ENTRYPOINT ["/e2e/run-in-container.sh"]
