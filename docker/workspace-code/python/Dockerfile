FROM python:3.13-slim
LABEL learnharness.workspace=code
ENV HOME=/work/.home PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install --no-cache-dir pytest==8.3.5 && mkdir -p /opt/scaffold /opt/lh
