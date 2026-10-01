// A value with a one-tap Copy button (phone numbers, GSTINs, bill numbers).
import { useToast } from '../lib/ToastContext';
import { Icon } from './icons';

export default function CopyText({ value, href, label }: { value: string; href?: string; label?: string }) {
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied', label ? `${label}: ${value}` : value);
    } catch { toast.error(new Error('Could not copy — select the text and copy it instead.')); }
  }
  return (
    <span className="row tight" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {href ? <a href={href}>{value}</a> : <span>{value}</span>}
      <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => void copy()}
              aria-label={`Copy ${label ?? value}`} title="Copy">
        <Icon name="copy" size={13} />
      </button>
    </span>
  );
}
