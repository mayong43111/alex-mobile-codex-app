FROM node:22.23.2-bookworm-slim AS web-build
WORKDIR /opt/web
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

FROM node:22.23.2-bookworm-slim AS runtime
ARG OPENMONTAGE_REV=08e2151fa02de28a5d6a312b3d575692bf147ad7
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/calesthio/OpenMontage.git /opt/openmontage \
    && cd /opt/openmontage && git checkout "$OPENMONTAGE_REV" \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir pyyaml==6.0.3 pydantic==2.12.5 jsonschema==4.26.0 python-dotenv==1.2.2 Pillow==12.1.1 requests==2.32.5 av==18.1.0
WORKDIR /opt/studio
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm install --global @openai/codex@0.155.1
COPY runtime/ ./runtime/
ENV PYTHONPATH=/opt/openmontage PATH=/opt/venv/bin:$PATH CODEX_HOME=/state/codex SERVICES_FILE=/run/secrets/services
RUN mkdir -p /state/codex /state/montage /state/workspaces && chown -R node:node /state
USER node
CMD ["node", "runtime/gateway.mjs"]

FROM runtime AS webapp
USER root
COPY --from=web-build /opt/web/dist ./app/dist
COPY app/server/ ./app/server/
COPY app/src/domain.ts ./app/src/domain.ts
RUN rm -rf /state && ln -s /home/studio/runtime /state
ENV HOSTING_MODE=appservice NODE_ENV=production API_PORT=8080 DATA_DIR=/home/studio/data RUNTIME_HOST=127.0.0.1
EXPOSE 8080
USER node
CMD ["node", "runtime/webapp.mjs"]