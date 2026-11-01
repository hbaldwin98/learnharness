FROM node:24-slim
LABEL learnharness.workspace=code
ENV HOME=/work/.home NODE_NO_WARNINGS=1
COPY package.json /opt/scaffold/package.json
COPY load-check.mjs /opt/lh/load-check.mjs
RUN chmod -R a+rX /opt/scaffold /opt/lh
