## JS library for accessing HiMD Minidisc devices

This is a brand new library for reading and writing HiMD media.
Unlike [linux-minidisc](https://github.com/linux-minidisc/linux-minidisc), himd-js supports writing ATRAC3, ATRAC3+ and PCM audio as well as MP3.

For now, it is impossible to use this library as a standalone application - there's no CLI available.

## How to incorporate it into your project?

The library has two modes of operation:

### 1 - FileSystem access only

In this mode, it's only possible to read and write tracks' metadata (titles, track play order, etc.), upload MP3s and download the audio.

**It is not possible to upload ATRAC3/3+/PCM with this mode.**

Example:
```ts
async function example(){
    // When using Node.JS:
    const fs = new NativeHiMDFilesystem("/path/to/HiMD/root");
    // When using Chrome (FileSystemAccess API):
    const fs = await FSAHiMDFilesystem.init();

    const himd = await HiMD.init(fs);

    // Use the HiMD handle
    renameDisc(himd, "Example disc!");

    // Upload an MP3 file
    const stream = await himd.openWriteStream();
    const title = {
        title: "Example",
        album: "Test",
        artist: "Foobar",
    };
    await uploadMP3Track(himd, stream, mp3DataArrayBuffer, title, console.log);
    
    // Do not forget to flush the changes!
    await himd.flush();
}
```

### 2 - Direct mode (USB Mass Storage Controller mode)

Because this mode takes full control over the HiMD device, and can issue SCSI commands directly to it, it's possible to upload ATRAC3/3+/PCM audio

All the examples from mode 1 which utilize the `HiMD` object still work.

Example:
```ts
async function example(){
    // There are two ways to get the WebUSB handle for a HiMD device
    // 1. Under Chrome - use the `netmd-exploits` library with the 'HiMDUSBClassOverride' exploit
    // 2. Under Node.JS - use the legacy API of the `usb` library, then invoke `.detachKernelDriver()` on the interface object
    const fs = new UMSCHiMDFilesystem(webusbHiMDSCSIHandle);
    await fs.init();
    const driver = fs.driver;

    const himd = await HiMD.init(fs);

    // Upload a MAC-protected audio track (AT3/3+/PCM)
    const title = {
        title: "Example",
        album: "Test",
        artist: "Foobar",
    };

    // Create a WriteStream
    const stream = await himd.openWriteStream();

    // Create a new session
    const session = new UMSCHiMDSession(driver, himd);
    await session.performAuthentication();

    // Example for ATRAC3 at 66kbps (LP4 on normal Minidisc)
    const codecInfo = generateCodecInfo("AT3", HiMDKBPSToFrameSize.atrac3[66]);
    await uploadMacDependent(himd, session, stream, atrac3RawArrayBuffer, codecInfo, title, console.log);
    
    // Finalize the session
    await session.finalizeSession();
}
```

### Credits
- Thank you to M Karcher over at the MiniDisc.wiki Discord server for explaining how the DRM implemented by HiMD devices works. This wouldn't be possible without his incredible help.
- The linux-minidisc documentation on HiMD SCSI commands and file formats ([1](https://wiki.physik.fu-berlin.de/linux-minidisc/himddownload), [2](https://wiki.physik.fu-berlin.de/linux-minidisc/doku.php?id=himddiskformat), [3](https://wiki.physik.fu-berlin.de/linux-minidisc/himdscsi), [4](https://wiki.physik.fu-berlin.de/linux-minidisc/himddownload-keystuff))
