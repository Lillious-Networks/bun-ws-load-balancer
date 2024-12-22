import os from 'os';
const cpus = os.availableParallelism();
const workers = new Map<number, Worker>();

// Create a worker for each CPU core
for (let i = 0; i < cpus; i++) {
  workers.set(i, new Worker('./worker.ts'));
}

workers.forEach((worker, id) => {
  // If a worker errors, restart it
  worker.onerror = (err) => {
    console.error(`Worker ${id} exited with error: ${err.message}`);
    workers.set(id, new Worker('./worker.ts'));
  };
});