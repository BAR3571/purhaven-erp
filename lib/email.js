import nodemailer from 'nodemailer';

let _transport = null;
function transport() {
  if (_transport) return _transport;
  const host = process.env.SMTP_HOST || 'smtpout.secureserver.net';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const user = process.env.SMTP_USER || 'sales@uvcvtm.com';
  const pass = process.env.SMTP_PASSWORD;
  if (!pass) throw new Error('SMTP_PASSWORD env var is not set');
  _transport = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass }
  });
  return _transport;
}

export const FROM_DEFAULT = `"PurHaven" <${process.env.SMTP_USER || 'sales@uvcvtm.com'}>`;
export const REPLY_TO_DEFAULT = process.env.SMTP_USER || 'sales@uvcvtm.com';

/** Sends an email. opts: { to, subject, html, text?, attachments?, replyTo? } */
export async function sendMail(opts) {
  if (!opts?.to) throw new Error('to is required');
  if (!opts?.subject) throw new Error('subject is required');
  return transport().sendMail({
    from: FROM_DEFAULT,
    replyTo: opts.replyTo || REPLY_TO_DEFAULT,
    ...opts
  });
}
