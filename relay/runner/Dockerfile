# A hosted run's container (relay/src/hosted.ts, Runner): the released Overhand image plus the agent CLIs, serving one
# run on port 8080 (`overhand hosted-run`, packages/core/src/hosted-run.ts). The relay starts a fresh one per run and
# destroys it after; nothing in it outlives the run. wrangler builds it on `deploy --env staging` (relay/wrangler.jsonc).
# Pin each version before going live: the image is rebuilt from these on every deploy.
ARG OVERHAND_IMAGE=ghcr.io/craftly-io/overhand:latest
FROM ${OVERHAND_IMAGE}
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
USER root
# node for the agent CLIs, bubblewrap for Overhand's OS sandbox where the platform allows it (else the guard alone)
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm bubblewrap \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && mkdir -p /work && chown overhand:overhand /work \
  # Overhand's own git and gh read the run's token from its environment through gh; agent runs never get it
  && git config --system credential.https://github.com.helper '!gh auth git-credential' \
  && git config --system user.name "Overhand" \
  && git config --system user.email "overhand@users.noreply.github.com"
USER overhand
WORKDIR /work
# Overhand's folder and its secrets file in memory: gone with the container
ENV OVERHAND_HOME=/dev/shm/overhand \
  OVERHAND_SECRETS_FILE=/dev/shm/overhand/secrets.json
EXPOSE 8080
ENTRYPOINT ["tini", "--", "overhand"]
CMD ["hosted-run"]
