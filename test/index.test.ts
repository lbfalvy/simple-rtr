import { RtrAgent, rtrAgent, RtrConfig, State, TokenPair  } from "../src";
import jwt from 'jsonwebtoken'
import { Emit, Variable, variable } from "@lbfalvy/mini-events";
import { mockTime, Time, TimeManager } from "mockable-timer";
import { bufferedDispatch, CallOf, constant, thrower } from "buffered-dispatch";

describe('Reverse Token Rotation agent', () => {  
    var time!: Time
    var timeMgr!: TimeManager
    var refresh!: (s: string) => Promise<TokenPair|'invalid'>
    var servePair!: () => Promise<CallOf<typeof refresh>>
    var writeStorage!: Emit<[State|undefined]>
    var storage!: Variable<State|undefined>
    var config!: RtrConfig
    var first!: RtrAgent, second!: RtrAgent
    
    const getDefaultPair = (
        authLife = 60 * 5,
        refreshLife = 60 * 60 * 5
    ): TokenPair => ({
        refresh: jwt.sign({ exp: time.now() + refreshLife }, 'shhhh'),
        auth: jwt.sign({ exp: time.now() + authLife }, 'shhhh')
    })

    beforeEach(() => {
        [writeStorage, storage] = variable();
        [time, timeMgr] = mockTime();
        [refresh, servePair] = bufferedDispatch<[string], TokenPair | 'invalid'>()
        config = {
            time, refresh,
            storage: [writeStorage, storage],
            log: console.log,
            lockExpiry: 10, renewOnTtl: 60,
        }
        first = rtrAgent(config), second = rtrAgent(config)
        if (second.uniqueDelay < first.uniqueDelay) [second, first] = [first, second]
    })

    test('Can log in and out correctly', async () => {
        // Setup
        expect(first.session.get()).toBeUndefined()
        expect(storage.get()).toBeUndefined()
        const onSession = jest.fn()
        first.session.changed(onSession, true)
        // Login
        first.setPair(getDefaultPair());
        await timeMgr.flushMtq()
        const session = first.session.get()
        expect(session).toBeDefined()
        expect(onSession).toHaveBeenLastCalledWith(session, undefined)
        expect(second.session.get()).toBeDefined()
        // Logout
        first.setPair(undefined)
        await timeMgr.flushMtq()
        expect(onSession).toHaveBeenLastCalledWith(undefined, session)
        expect(first.session.get()).toBeUndefined()
        expect(second.session.get()).toBeUndefined()
    })

    test('Refreshing is executed as expected', async () => {
        second.setPair(getDefaultPair())
        await timeMgr.progressTo(4*60 + 1) // Wait until renewal is due
        expect(storage.get()).toHaveProperty('lockedAt') // Verify that it's locked
        await servePair().then(constant(getDefaultPair())) // serve the first request
        // Verify that no second request is made
        const forbiddenFn = jest.fn()
        servePair().then(forbiddenFn)
        await timeMgr.progress(5)
        expect(forbiddenFn).not.toHaveBeenCalled()
        expect(storage.get()).not.toHaveProperty('lockedAt') // Verify that the lock is released
    })

    test('Refreshing fails and is retried in a timely manner', async () => {
        second.setPair(getDefaultPair())
        // Fail first request
        servePair().then(thrower(new Error('Something broke')))
        await timeMgr.progress(60 * 4 + 1)
        const secnodRequest = jest.fn(constant(getDefaultPair()))
        servePair().then(secnodRequest)
        // Wait within lock expiry
        await timeMgr.progress(5)
        expect(secnodRequest).not.toHaveBeenCalled()
        // Wait until after lock expiry
        await timeMgr.progress(6)
        expect(secnodRequest).toHaveBeenCalled()
    })

    test('The session is cleared if refresh yields invalid', async () => {
        second.setPair(getDefaultPair())
        // Reject request
        servePair().then(constant('invalid'))
        await timeMgr.progress(4 * 60 + 2)
        console.log(timeMgr.getQueue())
        expect(first.session.get()).toBeUndefined()
    })

    test('The session is cleared on timeout', async () => {
        first.setPair(getDefaultPair(5*60, 10*60))
        // renewOnTtl = 60, lockExpiry = 10
        // (refreshLife - accessLife + renewOnTtl) / lockExpiry
        // (10*60 - 5*60 + 60) / 10 = 36
        for (let i = 0; i < 36; i++) {
            servePair().then(thrower(new Error('Network unreachable')))
        }
        await timeMgr.progress(10 * 60 - 1)
        expect(storage.get()).toBeDefined()
        // It takes up to lockExpiry + epsilon + uniqueDelay for the agents to conclude
        // that the final request failed
        await timeMgr.progress(12)
        expect(storage.get()).toBeUndefined()
    })
})