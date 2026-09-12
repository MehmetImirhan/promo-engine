import type { Readable } from 'node:stream';
import busboy from 'busboy';
import { Router, type Request, type Response } from 'express';
import { Validation } from '../shared/errors.js';
import { createJobFields, idParams } from './schemas.js';
import type { IngestService, Upload } from './service.js';

interface MultipartResult {
  fields: Record<string, string>;
  upload: Upload | null;
}

/**
 * Drive busboy over the request. The single `file` part is handed to
 * `onFile` as a stream while it is still arriving; other parts become
 * fields. Resolves once the request body is fully consumed and the upload
 * has finished (or rejected).
 */
function readMultipart(req: Request, onFile: (file: Readable) => Promise<Upload>): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: req.headers, limits: { files: 1, fields: 10, fieldSize: 1024 } });
    } catch {
      reject(new Validation('Expected a multipart/form-data body'));
      return;
    }

    const fields: Record<string, string> = {};
    let upload: Promise<Upload> | null = null;

    parser.on('field', (name, value) => {
      fields[name] = value;
    });
    parser.on('file', (name, stream) => {
      if (name !== 'file' || upload !== null) {
        stream.resume(); // unexpected part: drain it so busboy can continue
        return;
      }
      upload = onFile(stream).catch((err: unknown) => {
        stream.resume();
        throw err;
      });
    });
    parser.on('error', reject);
    parser.on('close', () => {
      (upload ?? Promise.resolve(null)).then((u) => resolve({ fields, upload: u }), reject);
    });

    req.pipe(parser);
  });
}

/** Thin handlers: multipart/params → service → JSON. */
export function ingestRouter(ingest: IngestService): Router {
  const router = Router();

  router.post('/ingest/jobs', async (req: Request, res: Response) => {
    const { fields, upload } = await readMultipart(req, (file) => ingest.storeUpload(file));
    if (!upload) throw new Validation('Missing file part "file"', [{ path: 'file', message: 'Required' }]);

    const parsed = createJobFields.safeParse(fields);
    if (!parsed.success) {
      await ingest.discardUpload(upload);
      throw parsed.error;
    }

    const { job, created } = await ingest.createJob(parsed.data.vendor_id, upload);
    res.status(created ? 202 : 200).json({ id: job.id, status: job.status, created });
  });

  router.get('/ingest/jobs/:id', async (req: Request, res: Response) => {
    const { id } = idParams.parse(req.params);
    res.json(await ingest.getStatus(id));
  });

  router.post('/ingest/jobs/:id/replay-failed', async (req: Request, res: Response) => {
    const { id } = idParams.parse(req.params);
    res.json(await ingest.replayFailed(id));
  });

  return router;
}
