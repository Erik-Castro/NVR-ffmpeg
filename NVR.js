const path = require("node:path");
const fsPromises = require('node:fs').promises;
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const winston = require('winston');

class NVRConfig {
    static DEFAULT = Object.freeze({
        rtspUrl: 'rtsp://192.168.1.1:554',
        outputDir: path.join(__dirname, 'recordings'),
        segmentDuration: 5,
        maxStorageGB: 20,
        storageCheckInterval: 60 * 1000,
        maxDeleteAttempts: 3,
        ffmpegArgs: ['-c:v', 'libx264', '-crf', '23', '-c:a', 'aac'],
    });

    constructor(options = {}) {
        this.rtspUrl = options.rtspUrl || NVRConfig.DEFAULT.rtspUrl;
        this.outputDir = options.outputDir || NVRConfig.DEFAULT.outputDir;
        this.segmentDuration = options.segmentDuration || NVRConfig.DEFAULT.segmentDuration;
        this.maxStorage = (options.maxStorageGB || NVRConfig.DEFAULT.maxStorageGB) * 1024 ** 3;
        this.storageCheckInterval = options.storageCheckInterval || NVRConfig.DEFAULT.storageCheckInterval;
        this.maxDeleteAttempts = options.maxDeleteAttempts || NVRConfig.DEFAULT.maxDeleteAttempts;
        this.ffmpegArgs = options.ffmpegArgs || NVRConfig.DEFAULT.ffmpegArgs;
    }
}

class NVRRecorder {
    constructor(config) {
        this.config = config;
        this.currentProcess = null;
        this.isRecording = false;
        this.setupOutputDir();
    }

    setupOutputDir() {
        if (!fs.existsSync(this.config.outputDir)) {
            fs.mkdirSync(this.config.outputDir, { recursive: true });
        }
    }

    async start() {
        if (this.isRecording) return;
        this.isRecording = true;

        const outputPath = path.join(this.config.outputDir, 'segment_%03d.ts');
        const playlistPath = path.join(this.config.outputDir, 'playlist.m3u8');
        const args = [
            '-threads', '2',
            '-i', this.config.rtspUrl,
            ...this.config.ffmpegArgs,
            '-f', 'segment',
            '-segment_time', this.config.segmentDuration,
            '-segment_format', 'mpegts',
            '-segment_list', playlistPath,
            '-segment_list_flags', 'live',
            '-reset_timestamps', '1',
            outputPath
        ];

        this.currentProcess = spawn('nice', ['-n', '10', 'ffmpeg', ...args]);
        this.setupProcessHandlers()
    }

    setupProcessHandlers() {
        this.currentProcess.on('close', code => {
            this.isRecording = false;
            console.log(code === 0 ? 'Gravação Concluida' : `Erro na gravação (${code})`);
            this.restart();
        });

        this.currentProcess.on('error', (error) => {
            this.isRecording = false;
            console.error('Erro no FFmpeg:', error);
            this.restart();
        });
    }

    restart() {
        setTimeout(() => this.start(), 3000);
    }

    stop() {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.isRecording = false;
        }
    }
}

class StorageManager {
    constructor(config) {
        this.config = config;
        this.cleanupInterval = null;
        this.fileCache = new Map();
        this.cacheTTL = 30000
        this.lastCacheUpdate = null;
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            transports: [
                new winston.transports.File({ filename: 'storage-debug.log' })
            ]
        });
    }

    async startStorageMonitoring() {
        this.cleanupInterval = setInterval(
            () => this.cleanupOldFiles(),
            this.config.storageCheckInterval
        );
        this.logger.info("Monitoramento de Armazenamento iniciado");
    }

    async cleanupOldFiles() {
        try {
            let usedSpace = await this.calculateUsedSpace();
            while (usedSpace > this.config.maxStorage) {
                const files = await this.getSortedFiles();
                if (files.length === 0) break;

                const oldestFile = files[0];
                await this.safeDelete(oldestFile);
                usedSpace -= oldestFile.size;

                this.logger.info('Arquivo removido', {
                    file: oldestFile.name,
                    size: oldestFile.size,
                    remainingSpace: (this.config.maxStorage - usedSpace) / 1e9
                });
            }
        } catch (error) {
            this.logger.error('Erro na limpeza de arquivos', { error: error.message })
        }
    }

    async calculateUsedSpace() {
        try {
            const files = await fsPromises.readdir(this.config.outputDir);
            const batchSize = 100;
            let totalSize = 0;

            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.splice(i, i + batchSize);
                const sizes = await Promise.all(
                    batch.map(file => this.getFileSize(file))
                );

                totalSize += sizes.reduce((acc, size) => acc + size, 0);
            }

            return totalSize
        } catch (error) {
            this.logger.error("Erro ao calcular espaço usado", { error: error.message });
            return 0;
        }
    }

    async getFileSize(file) {
        try {
            const stats = await fsPromises.stat(path.join(this.config.outputDir, file));
            return stats.size;
        } catch (error) {
            this.logger.warn('Erro ao obter tamanho do arquivo', { file, error: error.message });
            return 0;
        }
    }

    async getSortedFiles() {
        try {
            if (this.lastCacheUpdate && Date.now() - this.lastCacheUpdate < this.cacheTTL) {
                return Array.from(this.fileCache.values());
            }

            const files = await fsPromises.readdir(this.config.outputDir);
            const batchSize = 100;
            const fileStats = [];

            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                const stats = await Promise.all(
                    batch.map(file => this.getFileSize(file))
                );

                fileStats.push(...stats.filter(Boolean));
            }

            this.fileCache = new Map(fileStats.map(stat => [stat.name, stat.size]));
            this.lastCacheUpdate = Date.now();

            return files.sort((a, b) => a.birthtimeMs - b.birthtimeMs);
        } catch (error) {
            this.logger.error('Erro ao listar arquivos', { error: error.message });
            return [];
        }
    }

    async getFileStats(file) {
        try {
            const stats = await fsPromises.stat(path.join(this.config.outputDir, file));
            return { name: file, ...stats };
        } catch (error) {
            this.logger.error('Erro ao obter stats do arquivo', { file, error: error.message });
            return null;
        }
    }

    async safeDelete(file) {
        let attempts = 0;
        while (attempts < this.config.maxDeleteAttempts) {
            try {
                await fsPromises.unlink(path.join(this.config.outputDir, file.name));
                this.fileCache.delete(file.name);
                return;
            } catch (error) {
                if (error.code === 'EBUSY') {
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempts + 1)));
                    attempts++;
                } else {
                    throw error;
                }
                throw new Error(`Falha ao deletar ${file.name} após ${attempts} tentativas`);
            }
        }
    }

    stopStorageMonitoring() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.logger.info('Monitoramento de armazenamento interrompido');
        }
    }

    async emergencyCleanup() {
        this.logger.warn('Iniciando limpeza de emergência');
        const files = await this.getSortedFiles();
        while (files.length > 0) {
            const file = files.shift();
            await this.safeDelete(file);
        }
        this.logger.warn('Limpeza de emergêmcia');
    }
}

class PerformanceMonitor {
    constructor() {
        this.metrics = {
            ffmpeg: { runs: 0, errors: 0, totalCpu: 0, totalDuration: 0 },
            storage: { cleanups: 0, filesDeleted: 0, spaceFreed: 0, errors: 0 },
            workers: { starts: 0, exits: 0, restarts: 0 }
        };

        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            transports: [
                new winston.transports.File({ filename: 'performance.log' })
            ]
        });
    }

    trackFFmpeg(process) {
        const startTime = Date.now();
        const usage = process.cpuUsage();

        process.on('exit', (code) => {
            const duration = Date.now() - startTime;
            const cpuUsage = process.cpuUsage(usage).user;

            this.metrics.ffmpeg.runs++;
            this.metrics.ffmpeg.totalCpu += cpuUsage;
            this.metrics.ffmpeg.totalDuration += duration;

            this.logger.info('FFmpeg completed', {
                duration,
                cpuUsage,
                exitCode: code
            });
        });
    }

    logFFmpegError(error) {
        this.metrics.ffmpeg.errors++;
        this.logger.error('FFmpeg error', { error: error.message });
    }

    logStorageCleanup({ duration, filesDeleted, spaceFreed }) {
        this.metrics.storage.cleanups++;
        this.metrics.storage.filesDeleted += filesDeleted;
        this.metrics.storage.spaceFreed += spaceFreed;

        this.logger.info('Storage cleanup', {
            duration,
            filesDeleted,
            spaceFreed
        });
    }

    logFileDeletion({ file, size, attempts, duration }) {
        this.logger.debug('File deleted', {
            file,
            size,
            attempts,
            duration
        });
    }

    logStorageError(error) {
        this.metrics.storage.errors++;
        this.logger.error('Storage error', { error: error.message });
    }

    logWorkerStart(type, pid) {
        this.metrics.workers.starts++;
        this.logger.info('Worker started', { type, pid });
    }

    logWorkerExit(type, pid, code, signal) {
        this.metrics.workers.exits++;
        this.logger.info('Worker exited', { type, pid, code, signal });
    }

    report() {
        console.log('Performance Report:');
        console.table(this.metrics);
        this.logger.info('Performance report', this.metrics);
    }
}

module.exports = {
    NVRConfig,
    NVRRecorder,
    StorageManager,
    PerformanceMonitor
}