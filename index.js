import express from 'express';
import fetch from 'node-fetch';

const {
  RC_BASE, RC_ACCESS_TOKEN, WEBHOOK_URL, VALIDATION_TOKEN,
  CRM_BASE, CRM_TOKEN
} = process.env;

const app = express();
app.use(express.json());

// 1) Create subscription (account-level telephony sessions; filter missed)
async function createSubscription() {
  const body = {
    eventFilters: [
      // Missed calls only:
      '/restapi/v1.0/account/~/telephony/sessions?missedCall=true',
      // Optionally include broader stream and classify via status.code:
      // '/restapi/v1.0/account/~/telephony/sessions'
    ],
    deliveryMode: {
      transportType: 'WebHook',
      address: WEBHOOK_URL,
      validationToken: VALIDATION_TOKEN  // echoed with every webhook
    }
  };

  const resp = await fetch(`${RC_BASE}/restapi/v1.0/subscription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RC_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Subscription error: ${t}`);
  }
  const json = await resp.json();
  console.log('Subscription created:', json.id);
  return json;
}

// 2) Webhook handler — MUST echo Validation-Token on creation
app.post('/ringcentral/events', async (req, res) => {
  const validationToken = req.headers['validation-token'];
  if (validationToken) res.set('Validation-Token', validationToken);
  res.status(200).end();

  const evt = req.body;  // Telephony Session event payload
  try {
    // Each event may include multiple parties; inspect first relevant party
    const party = evt?.body?.parties?.[0];
    const statusCode = party?.status?.code;        // 'Disconnected','VoiceMail','Answered',...
    const direction  = party?.direction;          // 'Inbound'/'Outbound'
    const telephonySessionId = evt?.body?.telephonySessionId;
    const sequence = evt?.body?.sequence;         // helps dedup/order
    const from = party?.from?.phoneNumber;
    const to   = party?.to?.phoneNumber;
    const endTime = evt?.body?.eventTime;

    // Classify “missed or dropped/not responded”
    const isMissedPayload = party?.missedCall === true; // when using missedCall filter
    const droppedBeforeAnswer =
      direction === 'Inbound' && statusCode === 'Disconnected';

    if (isMissedPayload || droppedBeforeAnswer || statusCode === 'VoiceMail') {
      // Push to CRM
      const payload = {
        event: isMissedPayload ? 'Missed' : (statusCode === 'VoiceMail' ? 'Voicemail' : 'Disconnected'),
        direction, from, to,
        telephonySessionId, sequence, endTime
      };
      await fetch(`${CRM_BASE}/api/calls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CRM_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      console.log('CRM logged:', payload);
    }
  } catch (e) {
    console.error('Handler error:', e.message);
  }
});

// 3) Start server and create subscription on boot
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Webhook listening on http://localhost:${PORT}`);
  try {
    await createSubscription();
  } catch (e) {
    console.error(e.message);
  }
});
