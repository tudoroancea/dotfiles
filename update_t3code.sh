mise -E linux lock --global --bump --platform linux-x64,linux-arm64 npm:t3
mise -E dev,linux install --locked npm:t3
mise -E dev,linux exec -- t3 --version
t3 service install
