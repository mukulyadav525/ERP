// Export button: downloads EVERY row the current filters select (see exportRows),
// says so when the file was cut at the cap, and never fails silently.
import { useState } from 'react';
import { EXPORT_MAX, exportRows } from '../lib/api';
import { useToast } from '../lib/ToastContext';
import { Button } from './ui';
import { Icon } from './icons';

export default function ExportButton<T = any>({ path, map, filename, size, label = 'Export' }: {
  path: string; map: (row: T) => Record<string, unknown>; filename: string; size?: 'sm'; label?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const { rows, capped } = await exportRows<T>(path, map, filename);
      if (!rows) toast.toast('Nothing to export', { tone: 'info', message: 'No rows match the current filters.' });
      else if (capped) toast.toast(`Exported the first ${EXPORT_MAX.toLocaleString('en-IN')} rows`, { tone: 'info', message: 'Narrow the filters (dates, status) to export the rest.' });
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  return <Button size={size} busy={busy} onClick={() => void run()}><Icon name="download" size={14} /> {label}</Button>;
}
