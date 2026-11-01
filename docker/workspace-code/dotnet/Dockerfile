FROM mcr.microsoft.com/dotnet/sdk:9.0
LABEL learnharness.workspace=code
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false NUGET_PACKAGES=/opt/nuget \
    HOME=/work/.home DOTNET_CLI_HOME=/work/.home MSBUILDDISABLENODEREUSE=1
COPY Solution.csproj /opt/scaffold/Solution.csproj
# Restore every package the scaffold needs into /opt/nuget at build time,
# so runs (which have no network) restore from it offline.
RUN mkdir -p /tmp/warm && cp /opt/scaffold/Solution.csproj /tmp/warm/ \
 && printf 'public class WarmTests { [Fact] public void Warm() {} }\n' > /tmp/warm/WarmTests.cs \
 && cd /tmp/warm && dotnet test -nologo -v q --logger "junit;LogFilePath=report.xml" \
 && cd / && rm -rf /tmp/warm /work && chmod -R a+rX /opt/nuget /opt/scaffold
