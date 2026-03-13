/**
 * src/api/mutations.js — Routes API pour les tickets de mutation Coeus
 *
 * GET  /api/mutations/suggested — liste les tickets en attente
 * POST /api/mutations/suggested — approuver ou rejeter un ticket
 * GET  /api/mutations/stats     — statistiques Coeus
 */

import { loadPendingTickets, processTicketApproval, getCoeusStats, auditPerformance } from '../agents/coeus.js';

export function createMutationsRoutes(app) {
  // GET /api/mutations/suggested — tickets en attente
  app.get('/api/mutations/suggested', (c) => {
    const tickets = loadPendingTickets();
    return c.json({
      pending_tickets: tickets.length,
      tickets:         tickets.slice(0, 20),
      last_ticket:     tickets[0]?.created_at || null,
    });
  });

  // POST /api/mutations/suggested — approbation / rejet
  app.post('/api/mutations/suggested', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body JSON invalide' }, 400);
    }

    const { approve, ticket_id } = body;
    if (typeof approve !== 'boolean' || !ticket_id) {
      return c.json({ error: 'Champs requis: approve (boolean), ticket_id (string)' }, 400);
    }

    const result = processTicketApproval(ticket_id, approve);
    if (result.error) return c.json(result, 404);
    return c.json(result);
  });

  // GET /api/mutations/stats — état de Coeus
  app.get('/api/mutations/stats', (c) => {
    return c.json(getCoeusStats());
  });

  // POST /api/mutations/audit — déclencher un audit immédiat
  app.post('/api/mutations/audit', async (c) => {
    const tickets = await auditPerformance();
    return c.json({
      success:         true,
      tickets_created: tickets.length,
      tickets,
    });
  });
}
