FROM node:24-slim
LABEL learnharness.workspace=code
ENV HOME=/work/.home NODE_NO_WARNINGS=1
COPY package.json /opt/scaffold/package.json
COPY load-check.mjs /opt/lh/load-check.mjs
# The language server (plan step 4): typescript-language-server over
# TypeScript 6 (the last line that ships tsserver), with Node's types.
RUN mkdir -p /opt/lsp && cd /opt/lsp && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --save-exact typescript-language-server@6.0.2 typescript@6.0.3 @types/node@24.19.2 \
 && npm cache clean --force
RUN chmod -R a+rX /opt/scaffold /opt/lh /opt/lsp
