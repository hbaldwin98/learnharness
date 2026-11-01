FROM gcc:14
LABEL learnharness.workspace=code
ENV HOME=/work/.home
ADD https://raw.githubusercontent.com/doctest/doctest/v2.4.11/doctest/doctest.h /opt/lh/include/doctest.h
COPY lh_doctest_main.cpp /opt/scaffold/lh_doctest_main.cpp
RUN chmod -R a+rX /opt/lh /opt/scaffold
