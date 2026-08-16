# Desktop icon provenance

`rangabot-primary-1024.png` is the Founder-approved 2026-08-14 primary mark and
the canonical source for the desktop icon. Its SHA-256 is
`52b471b2c9d83d39f5d39c908e1e49dd14cd42ca083d57c3f454739bfa5744a5`.

`rangabot.icns` contains the standard 16, 32, 128, 256, 512 and 1024 pixel
macOS representations compiled from that source. Its checked-in SHA-256 is
`87ddbd491cc954cac32c2f31ba9840fe5f99273b453c48122f38a2156a1ad910`.

Forge consumes the compiled icon directly and macOS packaging must retain its
bundle icon metadata. The icon is a proprietary Rangabot identity asset for
official product use; see `public/brand/README.md` for the rights boundary.

`rangabot.ico` is the Windows multi-frame container compiled from the same
approved source. It contains PNG-encoded 16, 24, 32, 48, 64, 128, and 256 px
RGBA frames. Its checked-in SHA-256 is
`5c3cd996b2a067f454af7df8e31ee72607fbde0e83dfc82d1afa4ec3546feb3b`.
Windows Forge and Squirrel packaging consume it directly for the executable,
installer, Start-menu shortcut, and uninstall identity.
