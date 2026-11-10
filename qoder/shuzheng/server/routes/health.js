import net from 'node:net';
import fs from 'node:fs';
import express from 'express';
import { config } from '../config.js';

function tcpProbe(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok, detail) => {
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true, 'port open'));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}

async function sdkProbe() {
  try {
    const mod = await import('seekdb');
    return { loadable: true, exports: Object.keys(mod).sort().slice(0, 20) };
  } catch (err) {
    return { loadable: false, error: err.code || err.message };
  }
}

export const healthRouter = express.Router();

healthRouter.get('/', async (req, res) => {
  const port = await tcpProbe(config.seekdb.host, config.seekdb.port);
  const sdk = await sdkProbe();

  res.json({
    ok: true,
    service: 'shuzheng',
    version: '0.1.0',
    stage: 'P6-导入/混合检索/证据卡/复习闭环',
    runtime: { node: process.version, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
    seekdb: {
      endpoint: `${config.seekdb.host}:${config.seekdb.port}/${config.seekdb.database}`,
      portOpen: port.ok,
      portDetail: port.detail,
      sdk,
      dimension: config.embedding.dimension,
      fulltextParser: config.collection.fulltextParser,
    },
    offline: {
      embeddingModelFile: config.embedding.modelFile,
      modelPresent: fs.existsSync(config.embedding.modelFile),
      tokenizerFile: config.embedding.tokenizerFile,
      tokenizerPresent: fs.existsSync(config.embedding.tokenizerFile),
      cloudModelCalls: 'forbidden',
      embeddingFunction: null,
    },
  });
});
