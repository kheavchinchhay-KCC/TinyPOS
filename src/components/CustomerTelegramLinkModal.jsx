import { useEffect } from "react";
import { Copy, Send } from "lucide-react";
import Modal from "./Modal";

export default function CustomerTelegramLinkModal({ link, botUsername, onClose }) {
  useEffect(() => {
    if (!link) return;
  }, [link]);
  if (!link) return null;
  const command = `/join ${link.code}`;
  const deepLink = botUsername ? `https://t.me/${botUsername}?start=customer_${link.code}` : "";
  async function copy(value) {
    await navigator.clipboard.writeText(value);
  }
  return (
    <Modal title="Connect customer Telegram" onClose={onClose}>
      <div className="telegram-customer-link">
        <Send size={42} />
        <h3>{link.customer_name}</h3>
        <p>This one-time code expires in 10 minutes.</p>
        <code>{link.code}</code>
        <button type="button" className="secondary-button" onClick={() => copy(command)}><Copy size={18} />Copy /join command</button>
        {deepLink && <a className="primary-button" href={deepLink} target="_blank" rel="noreferrer"><Send size={18} />Open Telegram invitation</a>}
        <div className="notice info">The customer must choose to connect. Linking enables points checks, offers and marketing messages. Sending <b>/stop</b> immediately disables marketing messages.</div>
      </div>
    </Modal>
  );
}
