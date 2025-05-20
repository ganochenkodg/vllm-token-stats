const Fastify = require('fastify');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const client = require('prom-client');
const os = require('os');

//get pod name
const hostname = os.hostname();

//get vLLM endpoint
const VLLM_ENDPOINT = process.env.VLLM_ENDPOINT || 'http://localhost:8000';

//connect to K8S endpoint with sa token
const K8S_API = 'https://kubernetes.default.svc';
const K8S_CA = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const K8S_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const token = fs.readFileSync(K8S_TOKEN_PATH, 'utf8');
const httpsAgent = new https.Agent({
  ca: fs.readFileSync(K8S_CA),
  rejectUnauthorized: false,
});

//create HTTP server
const fastify = Fastify({ logger: true });

//prometheus custom metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const vllmPromptTokens = new client.Counter({
  name: 'vllm_prompt_tokens',
  help: 'Prompt tokens used by VLLM',
  labelNames: ['hostname', 'namespace', 'client_name', 'full_path'],
});
const vllmCompletionTokens = new client.Counter({
  name: 'vllm_completion_tokens',
  help: 'Completion tokens produced by VLLM',
  labelNames: ['hostname', 'namespace', 'client_name', 'full_path'],
});
const vllmTotalTokens = new client.Counter({
  name: 'vllm_total_tokens',
  help: 'Total tokens processed by VLLM',
  labelNames: ['hostname', 'namespace', 'client_name', 'full_path'],
});
register.registerMetric(vllmPromptTokens);
register.registerMetric(vllmCompletionTokens);
register.registerMetric(vllmTotalTokens);
register.setDefaultLabels({
  hostname: hostname,
});

//get pod name and namespace by IP
async function getPodInfoByIP(ip) {
  try {
    //call K8S API to find client info
    const res = await axios.get(`${K8S_API}/api/v1/pods`, {
      params: { fieldSelector: `status.podIP=${ip}` },
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent,
    });

    const items = res.data.items;
    if (items.length > 0) {
      const pod = items[0];
      return {
        podName: pod.metadata.name,
        namespace: pod.metadata.namespace,
      };
    }
  } catch (err) {
    console.error('Error fetching pod info:', err.message);
  }

  return { podName: ip, namespace: null };
}

//expose prometheus metrics
fastify.get('/metrics', async (request, reply) => {
  try {
    const metrics = await register.metrics();
    reply.header('Content-Type', register.contentType).send(metrics);
  } catch (err) {
    reply.status(500).send('Could not collect metrics');
  }
});

//proxify all requests to /v1 vLLM API
fastify.route({
  method: ['GET', 'POST'],
  url: '/v1/*',
  logLevel: 'silent',
  handler: async (request, reply) => {
    const clientIp =
      request.headers['x-forwarded-for']?.split(',')[0] || request.ip;
    const podInfo = await getPodInfoByIP(clientIp);

    try {
      const fullPath = request.raw.url;
      const vllmPath = VLLM_ENDPOINT + fullPath;

      //remove host and content-length from original headers
      const { host, 'content-length': _, ...headers } = request.headers;

      //prepare connection params
      const axiosConfig = {
        method: request.method,
        url: vllmPath,
        headers,
        responseType: 'stream',
      };
      if (request.method === 'POST') {
        axiosConfig.data = request.body;
      }

      //await for vLLM response
      const vllmRes = await axios(axiosConfig);

      //build full answer body from stream chunks
      let rawData = '';
      vllmRes.data.on('data', (chunk) => {
        rawData += chunk.toString('utf8');
      });

      //handle end of the ata
      vllmRes.data.on('end', () => {
        try {
          //try to find token statistics in output
          const tokenMatch = rawData.match(
            /"usage":\{[^}]*?"total_tokens":\d+[^}]*?}/
          );
          //no token info - skip logging
          if (!tokenMatch) return;
          const tokenJson = `{${tokenMatch[0]}}`;
          const usage = JSON.parse(tokenJson).usage;
          const logMessage =
            `[${new Date().toISOString()}] ${request.method} from ${clientIp} (${podInfo.namespace}/${podInfo.podName}) ${fullPath}` +
            (usage.total_tokens !== undefined
              ? ` | tokens: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}`
              : '');
          console.log(logMessage);

          //prepare labels for prometheus metrics
          const labels = {
            namespace: podInfo.namespace || 'unknown',
            client_name: podInfo.podName || 'unknown',
            full_path: fullPath || 'unknown',
          };

          //increase metric values
          vllmPromptTokens.inc(labels, usage.prompt_tokens || 0);
          vllmCompletionTokens.inc(labels, usage.completion_tokens || 0);
          vllmTotalTokens.inc(labels, usage.total_tokens || 0);
        } catch (e) {
          //do nothing on parsing errors
        }
      });

      //send all headers and data to client
      for (const [key, value] of Object.entries(vllmRes.headers)) {
        reply.header(key, value);
      }
      reply.status(vllmRes.status);
      return reply.send(vllmRes.data);
    } catch (err) {
      console.error(`Proxy ${request.method} error:`, err.message);
      reply
        .code(err.response?.status || 500)
        .send(err.response?.data || { error: 'Proxy error' });
    }
  },
});

//start HTTP server
fastify.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
