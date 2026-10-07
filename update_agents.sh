cd ~/.config/mise

agents=(npm:@openai/codex claude npm:@earendil-works/pi-coding-agent)

mise -E dev,macos,pi lock --global --bump \
  --minimum-release-age=0 --platform macos-arm64 "${agents[@]}" &&
mise -E dev,linux,pi lock --global --bump \
  --minimum-release-age=0 --platform linux-x64 "${agents[@]}" &&
mise -E server,linux,pi lock --global --bump \
  --minimum-release-age=0 --platform linux-arm64 "${agents[@]}"

mise bootstrap --only tools
