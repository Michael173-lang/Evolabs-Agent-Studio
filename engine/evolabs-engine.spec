from PyInstaller.utils.hooks import collect_all, collect_submodules

hiddenimports = collect_submodules("evolabs_engine")
imageio_datas, imageio_binaries, imageio_hiddenimports = collect_all("imageio_ffmpeg")
hiddenimports += imageio_hiddenimports

a = Analysis(
    ["entrypoint.py"],
    pathex=["src"],
    binaries=imageio_binaries,
    datas=imageio_datas,
    hiddenimports=hiddenimports,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="evolabs-engine",
    console=True,
    debug=False,
    strip=False,
    upx=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="evolabs-engine",
)
