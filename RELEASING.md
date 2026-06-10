# Releasing a new version

1. Commit and push the changes, then tag:

   ```sh
   git tag v0.2.0 && git push origin main v0.2.0
   ```

2. Get the new tarball's checksum:

   ```sh
   curl -sL https://github.com/NathnaelDS/droidrop/archive/refs/tags/v0.2.0.tar.gz | shasum -a 256
   ```

3. In the tap (`~/Projects/homebrew-tap`, github.com/NathnaelDS/homebrew-tap),
   edit `Formula/droidrop.rb`: update the version in `url` and the `sha256`
   from step 2. Commit and push.

4. Verify:

   ```sh
   brew update && brew upgrade droidrop   # or: brew install nathnaelds/tap/droidrop
   brew test droidrop
   ```

Notes:

- The formula also pins Android platform-tools (`resource "platform-tools"`).
  That only needs bumping when a new adb matters — find versioned zips at
  `https://dl.google.com/android/repository/platform-tools_r<VER>-darwin.zip`,
  and update that `url`/`sha256` pair the same way.
- Local installs (`/Applications/DroidDrop.app`) come from `./menubar/build.sh`,
  which is independent of all this — brew users and source builders get
  identical apps.
