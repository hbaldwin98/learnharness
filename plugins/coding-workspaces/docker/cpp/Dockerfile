FROM gcc:14
LABEL learnharness.workspace=code
ENV HOME=/work/.home
# The language server (plan step 4): clangd from the distribution.
RUN apt-get update && apt-get install -y --no-install-recommends clangd && rm -rf /var/lib/apt/lists/*
ADD https://raw.githubusercontent.com/doctest/doctest/v2.4.11/doctest/doctest.h /opt/lh/include/doctest.h
COPY lh_doctest_main.cpp /opt/scaffold/lh_doctest_main.cpp
RUN chmod -R a+rX /opt/lh /opt/scaffold
