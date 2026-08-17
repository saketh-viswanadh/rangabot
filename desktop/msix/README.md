# Internal Windows MSIX inputs

This directory contains the immutable manifest and visual assets for the
unsigned `win32/x64` MSIX candidate. The package identity is intentionally
separate from any future signed production identity. Its publisher uses the
exact `OID.2.25.311729368913984317654407730594956997722=1` marker required
by Windows for unsigned test packages. It is the final Publisher field.

The three PNG assets are exact-size derivatives of
`desktop/assets/rangabot-primary-1024.png` (SHA-256
`52b471b2c9d83d39f5d39c908e1e49dd14cd42ca083d57c3f454739bfa5744a5`).
They are build inputs, not user data. Their dimensions and hashes are checked
before `MakeAppx.exe` is invoked and again against the completed MSIX.

- `StoreLogo.png`: 50x50, SHA-256 `58f9fe0de43915b127c1fec9a32257457f93e55cede415c6312500c1acea9740`
- `Square44x44Logo.png`: 44x44, SHA-256 `ae4ecb6a030277efcb54beb76c5d11440039ffed93646adb7a38acfa33423733`
- `Square150x150Logo.png`: 150x150, SHA-256 `f641c514fab9d7c5bf0c4c82ab2fe9dd206586ec9f561b00e0e13d376cdfbd50`

This manifest is an internal testing contract. It is not a Microsoft Store
reservation, production publisher identity, Authenticode claim, or signing
credential.
