# GC Optimization Testing Notes

## RULED OUT (Safe to restore later)

### 1. mthost IPC ArrayPool (Program.cs)
- ArrayPool for payload buffers in IPC message loop
- SendInputAsync taking ReadOnlyMemory<byte>
- **NOT the regression cause**

### 2. MuxProtocol.cs changes
- string.Create for sessionId parsing (instead of Encoding.GetString)
- ArrayPool-backed compression in CreateCompressedOutputFrame
- **NOT the regression cause**

## STILL TESTING

### 3. TtyHostClient.OnOutput (mt)
- Changed from `data.ToArray()` to `payload.Slice(4)` direct memory pass
- **TESTING NEXT**

### 4. StateWebSocketHandler.cs
- CollectionsMarshal.SetCount/AsSpan for message buffering
- **PENDING TEST**

### 5. Process monitors (mthost)
- GetForegroundProcess reusing _childrenMap dictionary
- macOS ArrayPool for pids buffer
- **PENDING TEST**

## Regression Symptom
- Heavy output (e.g., `ls -r`) blocks input (Ctrl+C doesn't work)
- Works fine on unchanged mt/mthost on port 2000
