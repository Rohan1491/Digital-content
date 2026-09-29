// REST API client — talks to Node.js/SQLite backend
const Sheets = {
  async request(method, endpoint, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(endpoint, opts);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  },

  getCustomers:           ()           => Sheets.request('GET',    '/api/customers'),
  addCustomer:            (c)          => Sheets.request('POST',   '/api/customers', c),
  updateCustomer:         (id, c)      => Sheets.request('PUT',    `/api/customers/${id}`, c),
  deleteCustomer:         (id)         => Sheets.request('DELETE', `/api/customers/${id}`),

  getOrders:              ()           => Sheets.request('GET',    '/api/orders'),
  addOrder:               (o)          => Sheets.request('POST',   '/api/orders', o),
  updateOrder:            (id, o)      => Sheets.request('PUT',    `/api/orders/${id}`, o),
  deleteOrder:            (id)         => Sheets.request('DELETE', `/api/orders/${id}`),
};

// AI — asks Claude questions about your business data
const AI = {
  async analyze(question) {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.answer;
  },
};
