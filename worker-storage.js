const NVRConfig = require('./NVR').NVRConfig;
const StorageManager = require('./NVR').StorageManager;


const init_A = (source, limit, directory) => {
    const config = new NVRConfig({
        maxStorageGB: limit || 5,
        outputDir: directory || '$HOME/recordings',
    });

    const storage = new StorageManager(config);
    storage.startStorageMonitoring();

    process.on("SIGINT", async () => {
        console.log('\nRecebido SIGINT. Encerrando monitoramento de armazenamento...');
        await storage.cleanupOldFiles();
        storage.stopStorageMonitoring();
        process.exit(0);
    });
};

module.exports = { init_A };

