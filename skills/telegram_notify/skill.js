// Skill: telegram_notify — Envoie un message Telegram via Bot API
// Requiert les variables d'environnement : BOT_TOKEN, CHAT_ID

const TELEGRAM_API = "https://api.telegram.org";

/**
 * Envoie un message Telegram.
 *
 * @param {object} params
 * @param {string} params.text                   - Texte du message à envoyer
 * @param {string} [params.parse_mode='Markdown'] - Mode de formatage : Markdown, MarkdownV2 ou HTML
 * @returns {Promise<{sent: boolean, message_id?: number, error?: string}>}
 */
export async function run({ text, parse_mode = "Markdown" } = {}) {
  if (!text) {
    return { sent: false, error: "Le paramètre 'text' est requis" };
  }

  const botToken = process.env.BOT_TOKEN;
  const chatId   = process.env.CHAT_ID;

  if (!botToken) {
    return { sent: false, error: "Variable d'environnement BOT_TOKEN manquante" };
  }
  if (!chatId) {
    return { sent: false, error: "Variable d'environnement CHAT_ID manquante" };
  }

  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       text,
        parse_mode: parse_mode,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      return {
        sent:  false,
        error: data.description ?? `HTTP ${response.status}`,
      };
    }

    return {
      sent:       true,
      message_id: data.result?.message_id,
    };

  } catch (err) {
    return { sent: false, error: err.message };
  }
}
