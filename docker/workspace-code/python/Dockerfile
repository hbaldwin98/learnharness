FROM python:3.13-slim
LABEL learnharness.workspace=code
ENV HOME=/work/.home PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# pytest for the tests; basedpyright (bundles its own Node) as the
# language server (plan step 4).
RUN pip install --no-cache-dir pytest==8.3.5 basedpyright==1.40.2 && mkdir -p /opt/scaffold /opt/lh
