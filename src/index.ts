import { Emit, variable, Variable } from "@lbfalvy/mini-events"
import jwtDecode from "jwt-decode"
import { Time } from "mockable-timer"

/**
 * A token pair as obtained from the authentication or refresh endpoint in RTR
 */
export interface TokenPair {
    /**
     * Auth token, accessible using `service.token`
     */
    auth: string,
    /**
     * Refresh token, not accessible from the outside but used for renewal
     */
    refresh: string
}

/**
 * Configuration options for the RTR agent
 */
export interface RtrConfig {
    /**
     * Refresh this much before expiry (seconds)
     */
    renewOnTtl: number
    /**
     * Retries this frequently if refresh fails (seconds)
     */
    lockExpiry: number
    /**
     * A tuple of a setter and a struct of a getter and a change event, which matches the return value
     * of `variable` from `@lbfalvy/mini-events`. Don't put a variable in it though, instead, connect the
     * appropriate functions to localStorage or some other shared state
     */
    storage: [Emit<[State|undefined]>, Variable<State|undefined>]
    /**
     * Time API
     */
    time: Time
    /**
     * Obtain a token pair using a refresh token, return 'invalid' if the refresh token is invalid
     * or throw if the network or other circumstances prevent renewal
     */
    refresh: (refreshToken: string) => Promise<TokenPair|'invalid'>
    /**
     * Debug output
     */
    log?: (...args: any[]) => void // Debug output
}

/**
 * RTR agent interface
 */
export interface RtrAgent {
    /**
     * Call this on login, user switching and logout
     * @param pair Initial token pair
     */
    setPair(pair?: TokenPair | undefined): void
    /**
     * Refresh the token pair for external reasons.
     */
    forceRefresh(): Promise<void>
    /**
     * Access the auth token
     */
    session: Variable<Variable<string> | undefined>
    /**
     * Unique random delay applied to all wait times to prevent thundering herd situations.
     */
    uniqueDelay: number
}

export type State = {
    pair: TokenPair,
    lockedAt?: number
}

function exp(token: { exp?: number }): number {
    if (!token.exp) return Infinity 
    return token.exp
}

function decodeToken<T>(token: string): (T & { exp?: number }) {
    try {
        return jwtDecode<T>(token)
    } catch(e) {
        console.error(e)
        console.error('Offending token:', token)
        throw e
    }
}

export class AssertionError extends Error {
    constructor(message?: string | undefined) {
        super(message)
    }
}

/**
 * Function that launches token renew flow
 * @param opts Delegates and configuration
 * @returns A function that always returns a valid token
 */
export function rtrAgent(opts: RtrConfig): RtrAgent {
    const { refresh, storage, renewOnTtl, lockExpiry, log, time } = opts
    const [ write, { get, changed } ] = storage
    let loop = false
    // Prevent thundering herd
    const uniqueDelay = Math.floor(Math.random() * 1000) / 1000
    /**
     * A state machine running concurrently in all tabs.
     * Principles:
     * - State may be read at any moment
     * --> continuous
     * - The whole machine may spontaneously halt and resume operation shortly or much later
     * --> timing resistant
     * - Network requests should be appropriately spaced and never repeated
     * --> locking
     * - Any single instance may spontaneously exit without cleanup
     * --> no SPOF
     */
    async function mainloop() {
        log?.(`Initializing authentication service with a unique delay of ${uniqueDelay}`)
        if (loop) throw new Error('Tried to launch second loop!')
        loop = true
        await Promise.resolve()
        try {
            while (loop) {
                const state = get()
                log?.('Current state at', time.now(), ':', state)
                // Initial, logged-out state
                if (!state) {
                    log?.('State empty, waiting for login...')
                    await new Promise<any>(r => changed(r, true, true))
                    continue
                }
                const refreshToken = decodeToken(state.pair.refresh)
                log?.('Refresh token expires at', refreshToken.exp)
                // Session expired > transition to logged-out
                if (exp(refreshToken) - time.now() < 0) {
                    log?.('Session expired, clearing state...')
                    write(undefined)
                    continue
                }
                const auth = decodeToken(state.pair.auth)
                log?.('Access token expires at', auth.exp)
                // Pending request > wait for timeout, then transition if it didn't already
                // can transition to stale token or expired session
                if (state.lockedAt) {
                    const expiry = lockExpiry
                    const unlockIn = time.now() - state.lockedAt + expiry
                    log?.(`Waiting ${unlockIn + uniqueDelay} for pending request to expire...`)
                    if (0 < unlockIn) {
                        await new Promise<void>(res => time.wait(unlockIn + uniqueDelay, res))
                        const newState = get()
                        if (newState?.lockedAt === state.lockedAt) {
                            log?.('Pending request expired, clearing timeout...')
                            write({ pair: state.pair })
                        }
                        continue
                    }
                }
                // stale token > transition to pending request
                // then try refreshing the token
                // then transition to fresh token state if it didn't already
                const renewIn = (exp(auth) - renewOnTtl - time.now()) * 1000
                if (renewIn < 0) {
                    const lockedAt = time.now()
                    log?.(`Stale access token, locking for renewal at ${lockedAt}...`)
                    write({ ...state, lockedAt })
                    try {
                        const result = await refresh(state.pair.refresh)
                        log?.('Refresh returned', result)
                        if (result === undefined) {
                            throw new AssertionError(
                                'ERROR: The token refresh callback returned undefined.\n' +
                                'Please make sure that this function either returns a token pair, ' +
                                'the string literal "invalid" or throws in the case of a network error.'
                            )
                        }
                        const newState = get()
                        if (result == 'invalid') {
                            log?.('Invalid refresh token, clearing state')
                            write(undefined)
                            continue
                        }
                        if (newState?.lockedAt !== lockedAt) {
                            write(undefined)
                            throw new AssertionError(
                                'Lock broken.\n' +
                                'This implies that something other than the RTR library ' +
                                'accessed the state.\n' +
                                'According to RTR rules, the session is now invalid.'
                            )
                        }
                        log?.('Saving new pair and unlocking...')
                        write({ pair: result })
                    } catch(ex) {
                        if (ex instanceof AssertionError) throw ex
                        log?.('Encountered error', ex)
                        log?.('Failed to refresh, lock maintained...')
                    }
                    continue
                }
                // valid token > wait until renewal due
                // transition to stale token
                log?.(`Waiting ${renewIn + uniqueDelay} for access token to go stale...`)
                await new Promise<void>(res => time.wait(renewIn + uniqueDelay, res))
            }
        } catch(e) {
            loop = false
            throw e
        }
    }
    mainloop()
    function createSession(): Variable<string> {
        log?.('Constructing new session')
        const state = get()
        if (!state) throw new Error('No active token')
        const [set, v] = variable<string>(state.pair.auth)
        const dispose = changed((fresh, old) => {
            if (fresh && old && fresh.pair.auth === old.pair.auth) return
            log?.('updating token string:', fresh)
            if (fresh === undefined) dispose()
            else set(fresh.pair.auth)
        }, true)
        return v
    }
    const [setSession, session] = variable<Variable<string>>()
    const dispose = changed((fresh, old) => {
        log?.('storage event old:', old, 'fresh:', fresh)
        if (!old) setSession(createSession())
        if (!fresh) setSession(undefined)
    })
    if (get()) setSession(createSession())
    const actions: RtrAgent = {
        setPair(pair) {
            if (pair) {
                write({ pair })
                if (!loop) mainloop()
            } else { write(undefined) }
        },
        async forceRefresh() {
            const state = get()
            if (!state) throw new Error('use setPair')
            const lockedAt = time.now()
            write({ ...state, lockedAt })
            const result = await refresh(state.pair.refresh)
            if (result == 'invalid') {
                log?.('Invalid refresh token, clearing state')
                write(undefined)
                return
            }
            const newState = get()
            if (newState?.lockedAt !== lockedAt) throw new AssertionError('Lock broken')
            write({ pair: result })
        },
        uniqueDelay,
        session
    }
    return actions
}