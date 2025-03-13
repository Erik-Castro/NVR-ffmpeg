#!/usr/bin/env node
const cluster = require('node:cluster');
const os = require('node:os');

const { program } = require('commander');

program
    .version('1.0.0')
    .description('Aplicação de gravação e monitoramento de armazenamento, escrita em Node.js')
    .requiredOption('-s, --source <url>', 'URL de origem dos dados, exemplo: rtsp://localhost:8554/stream')
    .option('-d,--directory <path>', 'Diretório de armazenamento dos dados, diretório padrão: ./records')
    .option('-l, --limit <gb>', 'Limite de armazenamento em GB, padrão: 5GB')
    .parse(process.argv);

const { source, directory, limit } = program.opts();

if (cluster.isMaster) {
    const MAX_RENTRIES = 5;
    const workers = {
        recording: { instances: null, retries: 0 },
        storage: { instances: null, retries: 0 }
    };

    const createWorker = (type) => {
        const worker = cluster.fork({ WORKER_TYPE: type });

        workers[type].instances = worker;
        workers[type].retries++;

        worker.on('exit', (code, signal) => {
            if (workers[type].retries < MAX_RENTRIES) {
                const delay = Math.pow(2, workers[type].retries) * 1000;
                console.log(`Reiniciando worker ${type}, em ${delay}`);
                setTimeout(() => createWorker(type), delay);
            } else {
                console.error(`Worker ${type} atingiu o limite máximo de reinicializações`);
            }
        });
    };

    const numCPUs = os.cpus().length;
    if (numCPUs >= 4) {
        createWorker('recording');
        createWorker('storage');
    } else {
        cluster.fork({ WORKER_TYPE: 'combined' });
        console.log('combined')
    }

} else {
    if (process.env.WORKER_TYPE === 'combined') {
        console.log('Iniciando processo de gravação e monitoramento de armazenamento');
        const { init } = require('./worker-recording');
        init(source, limit, directory);

        const { init_A } = require('./worker-storage');
        init_A(source, limit, directory);

    } else if (process.env.WORKER_TYPE === 'recording') {

        console.log('Iniciando gravação...');
        const { init } = require('./worker-recording');
        init(source, limit, directory);

    } else if (process.env.WORKER_TYPE === 'storage') {

        console.log('Iniciando processo de monitoramento de armazenamento');
        const { init_A } = require('./worker-storage');
        init_A(source, limit, directory);

    }
}