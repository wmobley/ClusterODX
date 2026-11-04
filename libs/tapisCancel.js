'use strict';

// Cancel a Tapis v3 job through the documented endpoint
// (POST /v3/jobs/{uuid}/cancel) and classify the result so callers can decide
// whether the job is gone, needs a retry, or needs an operator.
//
// Outcomes:
//   cancelled    Tapis accepted the cancel request.
//   not_found    Tapis reports no such job for this token (cancel and GET both 404).
//   unauthorized Tapis rejected the token (401/403). Never treated as success.
//   failed       Any other error, including 5xx and network errors. Retryable.
const OUTCOMES = Object.freeze({
    CANCELLED: 'cancelled',
    NOT_FOUND: 'not_found',
    UNAUTHORIZED: 'unauthorized',
    FAILED: 'failed'
});

const TERMINAL_OUTCOMES = new Set([OUTCOMES.CANCELLED, OUTCOMES.NOT_FOUND]);

const statusOf = error => error && error.response && Number(error.response.status);

const safeMessage = error => {
    if (!error) return 'unknown error';
    const data = error.response && error.response.data;
    if (data && typeof data.message === 'string') return data.message.slice(0, 300);
    return String(error.message || error).slice(0, 300);
};

// `client` is an axios-like instance already carrying the X-Tapis-Token header.
const cancelTapisJob = async (client, tapisJobId) => {
    if (!client || typeof client.post !== 'function') throw new Error('Tapis client is required');
    if (!tapisJobId) throw new Error('Tapis job id is required');

    const path = `/v3/jobs/${encodeURIComponent(tapisJobId)}`;
    const startedAt = Date.now();
    const result = status => Object.assign(status, { tapisJobId, elapsedMs: Date.now() - startedAt });

    try {
        const response = await client.post(`${path}/cancel`);
        return result({ outcome: OUTCOMES.CANCELLED, status: response && response.status });
    } catch (error) {
        const status = statusOf(error);
        if (status === 401 || status === 403) {
            return result({ outcome: OUTCOMES.UNAUTHORIZED, status, message: safeMessage(error) });
        }
        if (status === 404) {
            // 404 on cancel can mean "no such job" or "job already finished"; only
            // a matching 404 on GET lets us call the job gone.
            try {
                if (typeof client.get === 'function') await client.get(path);
                return result({ outcome: OUTCOMES.FAILED, status, message: safeMessage(error) });
            } catch (getError) {
                const getStatus = statusOf(getError);
                if (getStatus === 404) return result({ outcome: OUTCOMES.NOT_FOUND, status });
                if (getStatus === 401 || getStatus === 403) {
                    return result({ outcome: OUTCOMES.UNAUTHORIZED, status: getStatus, message: safeMessage(getError) });
                }
                return result({ outcome: OUTCOMES.FAILED, status: getStatus || status, message: safeMessage(getError) });
            }
        }
        return result({ outcome: OUTCOMES.FAILED, status, code: error && error.code, message: safeMessage(error) });
    }
};

const isTerminalOutcome = outcome => TERMINAL_OUTCOMES.has(outcome && outcome.outcome ? outcome.outcome : outcome);

module.exports = { cancelTapisJob, isTerminalOutcome, OUTCOMES };
