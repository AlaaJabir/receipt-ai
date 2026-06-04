import { app } from '../server';

export default function handler(req: any, res: any) {
  const { path, ...query } = req.query || {};
  const route = Array.isArray(path) ? path.join('/') : path || '';
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      value.forEach(item => params.append(key, String(item)));
    } else if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  req.url = `/api/${route}${params.toString() ? `?${params.toString()}` : ''}`;
  return app(req, res);
}
