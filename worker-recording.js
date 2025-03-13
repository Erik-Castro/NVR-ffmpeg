const NVRConfig = require('./NVR').NVRConfig;
const NVRRecorder = require('./NVR').NVRRecorder;

const init = (source, limit, directory) => {
    const config = new NVRConfig({
        rtspUrl: `${source}`,
        maxStorageGB: `${limit || 5}`,
        outputDir: `${directory || '$HOME/recordings'}`,
    });

    const recorder = new NVRRecorder(config);
    recorder.start();

    process.on("SIGINT", () => {
        console.log("\nRecebido SIGINT. Encerrando gravação...");
        recorder.stop();
        process.exit(0);
    });
};


module.exports = { init };
