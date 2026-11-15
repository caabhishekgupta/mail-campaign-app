// Minimal Brevo v3 API client (server-side; API key never reaches the browser)
const BASE = "https://api.brevo.com/v3";

export class Brevo {
  constructor(apiKey) { this.apiKey = apiKey; }

  async req(method, path, body, query) {
    const url = new URL(BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { "api-key": this.apiKey, "accept": "application/json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.message || data?.error || text || res.statusText;
      const err = new Error(`Brevo ${res.status}: ${msg}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  account()            { return this.req("GET", "/account"); }
  senders()            { return this.req("GET", "/senders"); }
  domains()            { return this.req("GET", "/senders/domains"); }
  lists(limit = 50)    { return this.req("GET", "/contacts/lists", null, { limit, offset: 0, sort: "desc" }); }
  folders()            { return this.req("GET", "/contacts/folders", null, { limit: 50 }); }
  createFolder(name)   { return this.req("POST", "/contacts/folders", { name }); }
  createList(name, folderId) { return this.req("POST", "/contacts/lists", { name, folderId }); }
  listContacts(listId, limit = 50, offset = 0) { return this.req("GET", `/contacts/lists/${listId}/contacts`, null, { limit, offset }); }
  contactsCount()      { return this.req("GET", "/contacts", null, { limit: 1 }); }

  // Bulk import contacts (CSV string with header) into list(s)
  importContacts(csvText, listIds, { updateExisting = true } = {}) {
    return this.req("POST", "/contacts/import", {
      fileBody: csvText,
      listIds,
      updateExistingContacts: updateExisting,
      emptyContactsAttributes: false,
    });
  }
  importStatus(processId) { return this.req("GET", `/processes/${processId}`); }

  createCampaign(payload)        { return this.req("POST", "/emailCampaigns", payload); }
  updateCampaign(id, payload)    { return this.req("PUT", `/emailCampaigns/${id}`, payload); }
  getCampaign(id)                { return this.req("GET", `/emailCampaigns/${id}`, null, { statistics: "globalStats" }); }
  campaigns(limit = 50, status)  { return this.req("GET", "/emailCampaigns", null, { limit, offset: 0, statistics: "globalStats", sort: "desc", status }); }
  sendNow(id)                    { return this.req("POST", `/emailCampaigns/${id}/sendNow`); }
  sendTest(id, emailTo)          { return this.req("POST", `/emailCampaigns/${id}/sendTest`, { emailTo }); }
  recipientsCount(id)            { return this.req("GET", `/emailCampaigns/${id}`); }
  deleteCampaign(id)             { return this.req("DELETE", `/emailCampaigns/${id}`); }
  aggregatedReport(days = 30) {
    const end = new Date(); const start = new Date(Date.now() - days * 864e5);
    const f = (d) => d.toISOString().slice(0, 10);
    return this.req("GET", "/smtp/statistics/aggregatedReport", null, { startDate: f(start), endDate: f(end) });
  }
}
