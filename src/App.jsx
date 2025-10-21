import React, { useEffect, useRef, useState } from 'react'

export default function App() {
  // ... keep your existing state
  const [log, setLog] = useState([])
  const [ws, setWs] = useState(null)
  const [roomId, setRoomId] = useState(localStorage.getItem('roomId') || '')
  const [userId, setUserId] = useState(localStorage.getItem('userId') || '8e4afa0a-6899-4119-91e2-55792b2e993f')
  const [currentQ, setCurrentQ] = useState(null)
  const [answered, setAnswered] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [remainingSec, setRemainingSec] = useState(null)   // integer seconds left
  const [progress, setProgress] = useState(0)              // 0..1 elapsed
  const deadlineRef = useRef(null)                         // ms timestamp
  const tickRef = useRef(null)
  const [isHost, setIsHost] = useState(false)
  const [awaitingScoreForQid, setAwaitingScoreForQid] = useState(null) // QUESTION UUID waiting on score.update
  const [wantToClose, setWantToClose] = useState(false)                 // user asked to close while waiting
  const closeTimeoutRef = useRef(null)

  const reallyClose = () => {
    if (closeTimeoutRef.current) { clearTimeout(closeTimeoutRef.current); closeTimeoutRef.current = null }
    setAwaitingScoreForQid(null)
    setWantToClose(false)
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'client-closed')
    setWs(null)
  }

  useEffect(() => {
    localStorage.setItem('userId', userId)
    const hostFlag = localStorage.getItem('isHost')
    if (hostFlag) setIsHost(true)
  }, [userId])

  const toggleHost = () => {
    const next = !isHost
    setIsHost(next)
    localStorage.setItem('isHost', next ? '1' : '')
  }

  const sendHostStart = () => {
    if (!ws) return
    ws.send(JSON.stringify({ type: 'host.start', payload: { roomId } }))
  }

  const add = (m) => setLog((prev) => [...prev, m])

  const stopTimer = () => {
    if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
    setRemainingSec(null)
    setProgress(0)
  }

  const startTimer = (serverTs, timeLimitSec) => {
    // derive a stable deadline from server time (reduces clock skew errors)
    const deadlineMs = serverTs + timeLimitSec * 1000
    deadlineRef.current = deadlineMs

    const update = () => {
      const now = Date.now()
      const totalMs = timeLimitSec * 1000
      const leftMs = Math.max(0, deadlineMs - now)
      setRemainingSec(Math.ceil(leftMs / 1000))
      setProgress(Math.min(1, (totalMs - leftMs) / totalMs))
      if (leftMs <= 0) {
        clearInterval(tickRef.current)
        tickRef.current = null
      }
    }

    // kick immediately, then tick ~10x/sec for smooth progress
    update()
    if (tickRef.current) clearInterval(tickRef.current)
    tickRef.current = setInterval(update, 100)
  }

  // Connect & WS handlers (adjusted)
  const connect = () => {
    const rid = roomId || prompt('Room ID?')
    setRoomId(rid)
    localStorage.setItem('roomId', rid)
    const base = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080'
    const socket = new WebSocket(`${base}/v1/rooms/${rid}/play`)

    socket.onopen = () => {
      add('WS open')
      socket.send(JSON.stringify({
        type: 'auth.join',
        payload: { roomId: rid, userId, token: 'demo', device: { ua: 'web', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, latencyMs: 0 } }
      }))
    }

   socket.onmessage = (ev) => {
     let msg = null
     try { msg = JSON.parse(ev.data) } catch { add(ev.data); return }
     add(`${msg.type}`)

     if (msg.type === 'question.show') {
       const p = msg.payload
       setCurrentQ(p)
       setAnswered(false)
       setAccepted(false)
       setAwaitingScoreForQid(null)
       startTimer(p.serverTs, p.timeLimitSec)
     } else if (msg.type === 'answer.received') {
       setAccepted(msg.payload.status === 'ACCEPTED')
     } else if (msg.type === 'score.update') {
       // only resolve if it's *our* score for the same question we answered
       // server payload: { userId, delta, total } — no qid; we’ll resolve on any score.update for our user.
       if (msg.payload.userId === userId && msg.payload.qid === awaitingScoreForQid) {
         if (closeTimeoutRef.current) { clearTimeout(closeTimeoutRef.current); closeTimeoutRef.current = null }
         setAwaitingScoreForQid(null)
         if (wantToClose) reallyClose()
       }
     } else if (msg.type === 'question.reveal') {
       setCurrentQ(null)
       stopTimer()
       setAnswered(false)
     }
   }

    socket.onclose = () => {
      add('WS closed')
      stopTimer()
    }

    setWs(socket)
  }

  const sendAnswer = (index) => {
    if (!ws || !currentQ || answered) return
    if (remainingSec !== null && remainingSec <= 0) return
    setAnswered(true)
    setAwaitingScoreForQid(currentQ.qid)
    ws.send(JSON.stringify({
      type: 'answer.submit',
      payload: {
        qid: currentQ.qid,
        optionIndex: index,
        answerWindowId: currentQ.answerWindowId,
        clientTs: Date.now()
      }
    }))
    // safety timeout: if score.update doesn't arrive, don't block forever
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current)
    closeTimeoutRef.current = setTimeout(() => {
      setAwaitingScoreForQid(null)
      if (wantToClose) reallyClose()
    }, 4000) // 4s grace window; adjust as needed
  }

  const requestClose = () => {
    if (awaitingScoreForQid) {
      setWantToClose(true)
      add('Waiting for score.update before closing…')
      // socket will close in score.update handler or timeout
    } else {
      reallyClose()
    }
  }

  return (
    <div style={{fontFamily:'system-ui', padding:20}}>
      <h1>PushQuiz Client</h1>
      <div style={{display:'flex', gap:8}}>
        <input value={roomId} onChange={e=>setRoomId(e.target.value)} placeholder="Room ID"/>
        <button onClick={connect}>Connect</button>
      </div>
      <div style={{marginTop:12}}>
        <label>
            <input type="checkbox" checked={isHost} onChange={toggleHost}/>
                I am host
        </label>
        {isHost && ws && (
        <button onClick={sendHostStart} style={{marginLeft:12}}>
            ▶️ Start Match
        </button>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={requestClose}>
          Disconnect
        </button>
        {awaitingScoreForQid && (
          <span style={{ marginLeft: 8, fontSize: 12 }}>waiting for score…</span>
        )}
      </div>

      {currentQ && (
        <div style={{marginTop:16, padding:12, border:'1px solid #ddd', borderRadius:8}}>
          <h3>Q{currentQ.order}. {currentQ.text}</h3>

          {/* Countdown UI */}
          <div style={{display:'flex', alignItems:'center', gap:12, margin:'8px 0'}}>
            <div style={{width:180, height:8, background:'#eee', borderRadius:6, overflow:'hidden'}}>
              <div style={{height:'100%', width:`${Math.round(progress*100)}%`, background:'#4caf50'}} />
            </div>
            <div style={{minWidth:40, textAlign:'right', fontVariantNumeric:'tabular-nums'}}>
              {remainingSec ?? currentQ.timeLimitSec}s
            </div>
          </div>

          <ul style={{listStyle:'none', padding:0}}>
            {currentQ.options.map((opt, i) => (
              <li key={i} style={{marginBottom:8}}>
                <button
                  onClick={() => sendAnswer(i)}
                  disabled={answered || (remainingSec !== null && remainingSec <= 0)}
                  style={{padding:'8px 12px'}}
                >
                  {String.fromCharCode(65+i)}. {opt}
                </button>
              </li>
            ))}
          </ul>
          <p>
            {answered
              ? (accepted ? '✅ Answer accepted' : '…sending')
              : (remainingSec !== null && remainingSec <= 0 ? '⏰ Time up' : 'Pick an option')}
          </p>
        </div>
      )}

      <pre style={{background:'#111', color:'#0f0', padding:12, height:240, overflow:'auto', marginTop:16}}>
        {log.join('\n')}
      </pre>
    </div>
  )
}
