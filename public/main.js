const localVideo = document.getElementById('local_video');
const remoteContainer = document.getElementById('remote_container');
const roomName = document.getElementById('room_name');
let localStream = null;
let clientId = null;
let device = null;
let producerTransport = null;
let videoProducer = null;
let audioProducer = null;
let consumerTransport = null;
let videoConsumers = {};
let audioConsumers = {};
let videoToggle = true;
let recorder = null;
let isRecording = null;
const videoConstraint = {
    width: { ideal: 320 },
    height: { ideal: 240 },
    frameRate: { min: 1, max: 20 }
};
const screenConstraint = {
    frameRate: { max: 20 }
};

let streamerTrkID;

// =========== socket.io ==========
let socket = null;

// return Promise
function connectSocket() {
    if (socket) {
        socket.close();
        socket = null;
        clientId = null;
    }

    return new Promise((resolve, reject) => {
        socket = io.connect('/');

        socket.on('connect', async function (evt) {
            //console.log('socket.io connected()');

            // --- prepare room ---
            const roomName = getRoomName();
            console.log('socket.io connected(). prepare room=%s', roomName);
            await sendRequest('prepare_room', { roomId: roomName });
        });
        socket.on('error', function (err) {
            console.error('socket.io ERROR:', err);
            reject(err);
        });
        socket.on('disconnect', function (evt) {
            console.log('socket.io disconnect:', evt);
        });
        socket.on('message', function (message) {
            console.log('socket.io message:', message);
            if (message.type === 'welcome') {
                if (socket.id !== message.id) {
                    console.warn('WARN: something wrong with clientID', socket.io, message.id);
                }

                clientId = message.id;
                console.log('connected to server. clientId=' + clientId);

                resolve();
            }
            else {
                console.error('UNKNOWN message from server:', message);
            }
        });
        socket.on('newProducer', function (message) {
            console.log('socket.io newProducer:', message);
            const remoteId = message.socketId;
            const prdId = message.producerId;
            const kind = message.kind;
            if (kind === 'video') {
                console.log('--try consumeAdd remoteId=' + remoteId + ', prdId=' + prdId + ', kind=' + kind);
                consumeAdd(consumerTransport, remoteId, prdId, kind);
            }
            else if (kind === 'audio') {
                //console.warn('-- audio NOT SUPPORTED YET. skip remoteId=' + remoteId + ', prdId=' + prdId + ', kind=' + kind);
                console.log('--try consumeAdd remoteId=' + remoteId + ', prdId=' + prdId + ', kind=' + kind);
                consumeAdd(consumerTransport, remoteId, prdId, kind);
            }
        });

        socket.on('producerClosed', function (message) {
            console.log('socket.io producerClosed:', message);
            const localId = message.localId;
            const remoteId = message.remoteId;
            const kind = message.kind;
            console.log('--try removeConsumer remoteId=%s, localId=%s, track=%s', remoteId, localId, kind);
            removeConsumer(remoteId, kind);
            removeRemoteVideo(remoteId);
        });

        socket.on('set streamerID', (streamerID) => {
            console.log("StreamerID received: " + streamerID);
            streamerTrkID = streamerID;
        });

        if (!window.location.href.match(/^.*client$/)) {
            socket.emit("streamer ID", {});
        }
        if (window.location.href.match(/^.*client$/)) {
            socket.emit("request streamer ID", {});
        }
    });
}

function disconnectSocket() {
    if (socket) {
        socket.close();
        socket = null;
        clientId = null;
        console.log('socket.io closed..');
    }
}

function isSocketConnected() {
    if (socket) {
        return true;
    }
    else {
        return false;
    }
}

function sendRequest(type, data) {
    return new Promise((resolve, reject) => {
        socket.emit(type, data, (err, response) => {
            if (!err) {
                // Success response, so pass the mediasoup response to the local Room.
                resolve(response);
            } else {
                reject(err);
            }
        });
    });
}

// =========== media handling ==========
function stopLocalStream(stream) {
    let tracks = stream.getTracks();
    if (!tracks) {
        console.warn('NO tracks');
        return;
    }

    tracks.forEach(track => track.stop());
}

// return Promise
function playVideo(element, stream) {
    if (element.srcObject) {
        console.warn('element ALREADY playing, so ignore');
        return;
    }
    element.srcObject = stream;
    element.volume = 0;
    return element.play();
}

function pauseVideo(element) {
    element.pause();
    element.srcObject = null;
}

function addRemoteTrack(id, track) {
    console.log("track kind: " + track.kind + " id: " + id);
    if (track.kind == "video") {
        if (localVideo.srcObject) {
            localVideo.srcObject.getVideoTracks().forEach(oldtrack => {
                oldtrack.stop();
                localVideo.srcObject.removeTrack(oldtrack);
            });
            localVideo.srcObject.addTrack(track);
        } else {
            const newStream = new MediaStream();
            newStream.addTrack(track);
            playVideo(localVideo, newStream)
                .then(() => { localVideo.volume = 1.0 })
                .catch(err => { console.error('media ERROR:', err) });
        }
        return;
    }
    if (track.kind == "audio") {
        console.log("---1.ID: " + id + " -- strID: " + streamerTrkID);
        if (id == streamerTrkID) {
            console.log("---2.ID: " + id + " -- strID: " + streamerTrkID);
            if (localVideo.srcObject) {
                localVideo.srcObject.getAudioTracks().forEach(oldtrack => {
                    oldtrack.stop();
                    localVideo.srcObject.removeTrack(oldtrack);
                });

                localVideo.srcObject.addTrack(track);
                return;
            } else {
                const newStream = new MediaStream();
                newStream.addTrack(track);
                playVideo(localVideo, newStream)
                    .then(() => { localVideo.volume = 1.0 })
                    .catch(err => { console.error('media ERROR:', err) });
                return
            }

        }
        else {
            console.log("---3.ID: " + id + " -- strID: " + streamerTrkID);
            let video = findRemoteVideo(id);
            if (!video) {
                video = addRemoteVideo(id);
                video.controls = '1';
            }

            if (video.srcObject) {
                video.srcObject.addTrack(track);
                return;
            }

            const newStream = new MediaStream();
            newStream.addTrack(track);
            playVideo(video, newStream)
                .then(() => { video.volume = 1.0 })
                .catch(err => { console.error('media ERROR:', err) });
        }
    }
}

function addRemoteVideo(id) {
    let existElement = findRemoteVideo(id);
    if (existElement) {
        console.warn('remoteVideo element ALREADY exist for id=' + id);
        return existElement;
    }

    let element = document.createElement('video');
    remoteContainer.appendChild(element);
    element.id = 'remote_' + id;
    element.width = 240;
    element.height = 10;
    element.volume = 0;
    //element.controls = true;
    element.style = 'border: solid black 1px;';
    return element;
}

function findRemoteVideo(id) {
    let element = document.getElementById('remote_' + id);
    return element;
}

function removeRemoteVideo(id) {
    console.log(' ---- removeRemoteVideo() id=' + id);
    let element = document.getElementById('remote_' + id);
    if (element) {
        element.pause();
        element.srcObject = null;
        remoteContainer.removeChild(element);
    }
    else {
        console.log('child element NOT FOUND');
    }
}

function removeAllRemoteVideo() {
    while (remoteContainer.firstChild) {
        remoteContainer.firstChild.pause();
        remoteContainer.firstChild.srcObject = null;
        remoteContainer.removeChild(remoteContainer.firstChild);
    }
}

// ============ UI button ==========

function checkUseVideo() {
    const useVideo = document.getElementById('use_video').checked;
    return useVideo;
}

function checkUseAudio() {
    const useAudio = document.getElementById('use_audio').checked;
    return useAudio;
}

function checkUseScreen() {
    const useScreen = document.getElementById('use_screen').checked;
    return useScreen;
}

function startMedia() {
    if (localStream) {
        console.warn('WARN: local media ALREADY started');
        return;
    }

    let useVideo = checkUseVideo();
    const useAudio = checkUseAudio();
    const useScreen = checkUseScreen();

    // video constraint
    if (useVideo) {
        useVideo = videoConstraint;
    }

    navigator.mediaDevices.getUserMedia({ audio: useAudio, video: useVideo })
        .then((stream) => {
            localStream = stream;
            if (stream.getVideoTracks()[0]) {
                playVideo(localVideo, localStream);
            }
            updateButtons();
        })
        .catch(err => {
            console.error('media ERROR:', err);
        });

    if (useScreen) {
        navigator.mediaDevices.getDisplayMedia({ video: screenConstraint })
            .then(stream => {
                if (useVideo) {
                    localStream.getVideoTracks().forEach(track => {
                        track.stop();
                        localStream.removeTrack(track);
                    })
                }
                stream.getVideoTracks().forEach(track => {
                    localStream.addTrack(track);
                })
                pauseVideo(localVideo);
                disableElement('use_video');
                videoToggle = false;
            })
            .catch(err => {
                console.error('media ERROR:', err);
            });
    }
}

function stopMedia() {
    if (localStream) {
        pauseVideo(localVideo);
        stopLocalStream(localStream);
        localStream = null;
    }
    updateButtons();
}

function getRoomName() {
    const name = roomName.value;
    if (name && (name !== '')) {
        return name;
    }
    else {
        return '_default_room';
    }
}

function getRoomFromUrl() {
    const search = window.location.search;
    const re = new RegExp('room=([^&=]+)');
    const results = re.exec(search);
    let room = '';
    if (results) {
        room = results[1];
    }
    return room;
}

function isRoomSpecifiedByUrl() {
    let room = getRoomFromUrl();
    if ((room) && (room !== '')) {
        return true;
    }
    else {
        return false;
    }
}

function setupRoomFromUrl() {
    let room = getRoomFromUrl();
    if ((room) && (room !== '')) {
        roomName.value = room;
    }
}

async function connect() {
    if (!localStream) {
        console.warn('WARN: local media NOT READY');
        return;
    }

    // --- connect socket.io ---
    await connectSocket().catch(err => {
        console.error(err);
        return;
    });

    updateButtons();

    // --- get capabilities --
    const data = await sendRequest('getRouterRtpCapabilities', {});
    console.log('getRouterRtpCapabilities:', data);
    await loadDevice(data);

    // --- get transport info ---
    console.log('--- createProducerTransport --');
    const params = await sendRequest('createProducerTransport', {});
    console.log('transport params:', params);
    producerTransport = device.createSendTransport(params);
    console.log('createSendTransport:', producerTransport);

    // --- join & start publish --
    producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        console.log('--trasnport connect');
        sendRequest('connectProducerTransport', { dtlsParameters: dtlsParameters })
            .then(callback)
            .catch(errback);
    });

    producerTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        console.log('--trasnport produce');
        try {
            const { id } = await sendRequest('produce', {
                transportId: producerTransport.id,
                kind,
                rtpParameters,
            });
            callback({ id });
            console.log('--produce requested, then subscribe ---');
            subscribe();
        } catch (err) {
            errback(err);
        }
    });

    producerTransport.on('connectionstatechange', (state) => {
        switch (state) {
            case 'connecting':
                console.log('publishing...');
                break;

            case 'connected':
                console.log('published');
                break;

            case 'failed':
                console.log('failed');
                producerTransport.close();
                break;

            default:
                break;
        }
    });

    const useVideo = checkUseVideo();
    const useAudio = checkUseAudio();
    const useScreen = checkUseScreen();
    if (useVideo) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            const trackParams = { track: videoTrack };
            videoProducer = await producerTransport.produce(trackParams);
        }
    } else if (useScreen) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            const trackParams = { track: videoTrack };
            videoProducer = await producerTransport.produce(trackParams);
        }
    }
    if (useAudio) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            const trackParams = { track: audioTrack };
            audioProducer = await producerTransport.produce(trackParams);
        }
    }

    enabelElement('use_screen');

    updateButtons();
}

// IMPORTANT: To modify when the link is different (line 519) 
async function updateProduce() {
    if (localStream) {
        const useVideo = checkUseVideo();
        const useScreen = checkUseScreen();

        if (useVideo && !useScreen) {
            await navigator.mediaDevices.getUserMedia({ video: videoConstraint })
                .then(stream => {
                    localStream.getVideoTracks().forEach(track => {
                        track.stop();
                        localStream.removeTrack(track);
                    })
                    stream.getVideoTracks().forEach(async track => {
                        localStream.addTrack(track);
                        if (videoProducer) {
                            videoProducer.replaceTrack({ track: track });
                            videoProducer.resume();
                        } else {
                            let videoProducer = await producerTransport.produce({ track: track });
                            videoProducer.resume();
                        }
                    })
                    pauseVideo(localVideo);
                    playVideo(localVideo, localStream);
                })
        } else {
            if (!useScreen) {
                localStream.getVideoTracks().forEach(track => {
                    track.stop();
                    localStream.removeTrack(track);
                })
                // videoProducer.pause();
            }
            // IMPORTANT: To modify when the link is different
            if (!window.location.href.match(/^.*client$/)) {
                pauseVideo(localVideo);
            }
        }

        if (audioProducer) {
            const useAudio = checkUseAudio();
            if (useAudio) {
                audioProducer.resume();
            } else {
                audioProducer.pause();
            }
        }
    }
}

async function toogleVideo() {
    if (localStream) {
        const useVideo = checkUseVideo();
        if (videoToggle) {
            await navigator.mediaDevices.getDisplayMedia({ video: screenConstraint })
                .then(stream => {
                    localStream.getVideoTracks().forEach(track => {
                        track.stop();
                        localStream.removeTrack(track);
                    })
                    stream.getVideoTracks().forEach(async track => {
                        localStream.addTrack(track);
                        if (!videoProducer) {
                            videoProducer = await producerTransport.produce({ track: track });
                        } else {
                            videoProducer.replaceTrack({ track: track });
                        }
                        videoProducer.resume();
                    })
                    pauseVideo(localVideo);
                })
            disableElement('use_video');
            videoToggle = false;
        } else {
            enabelElement('use_video');
            localStream.getVideoTracks().forEach(track => {
                track.stop();
                localStream.removeTrack(track);
            })
            if (useVideo) {
                await navigator.mediaDevices.getUserMedia({ video: videoConstraint })
                    .then(stream => {
                        stream.getVideoTracks().forEach(async track => {
                            localStream.addTrack(track);
                            if (!videoProducer) {
                                videoProducer = await producerTransport.produce({ track: track });
                            } else {
                                videoProducer.replaceTrack({ track: track });
                            }
                        })
                        playVideo(localVideo, localStream);
                    })
            } else {
                videoProducer.pause();
            }
            videoToggle = true;
        }
    }
}

async function subscribe() {
    if (!isSocketConnected()) {
        await connectSocket().catch(err => {
            console.error(err);
            return;
        });

        // --- get capabilities --
        const data = await sendRequest('getRouterRtpCapabilities', {});
        console.log('getRouterRtpCapabilities:', data);
        await loadDevice(data);
    }


    // --- prepare transport ---
    console.log('--- createConsumerTransport --');
    if (!consumerTransport) {
        const params = await sendRequest('createConsumerTransport', {});
        console.log('transport params:', params);
        consumerTransport = device.createRecvTransport(params);
        console.log('createConsumerTransport:', consumerTransport);

        // --- join & start publish --
        consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            console.log('--consumer trasnport connect');
            sendRequest('connectConsumerTransport', { dtlsParameters: dtlsParameters })
                .then(callback)
                .catch(errback);
        });

        consumerTransport.on('connectionstatechange', (state) => {
            switch (state) {
                case 'connecting':
                    console.log('subscribing...');
                    break;

                case 'connected':
                    console.log('subscribed');
                    //consumeCurrentProducers(clientId);
                    break;

                case 'failed':
                    console.log('failed');
                    producerTransport.close();
                    break;

                default:
                    break;
            }
        });

        consumeCurrentProducers(clientId);
    }
}

async function consumeCurrentProducers(clientId) {
    console.log('-- try consuleAll() --');
    const remoteInfo = await sendRequest('getCurrentProducers', { localId: clientId })
        .catch(err => {
            console.error('getCurrentProducers ERROR:', err);
            return;
        });
    //console.log('remoteInfo.producerIds:', remoteInfo.producerIds);
    console.log('remoteInfo.remoteVideoIds:', remoteInfo.remoteVideoIds);
    console.log('remoteInfo.remoteAudioIds:', remoteInfo.remoteAudioIds);
    consumeAll(consumerTransport, remoteInfo.remoteVideoIds, remoteInfo.remoteAudioIds);
}

function disconnect() {
    if (localStream) {
        pauseVideo(localVideo);
        stopLocalStream(localStream);
        localStream = null;
    }
    if (videoProducer) {
        videoProducer.close(); // localStream will stop
        videoProducer = null;
    }
    if (audioProducer) {
        audioProducer.close(); // localStream will stop
        audioProducer = null;
    }
    if (producerTransport) {
        producerTransport.close(); // localStream will stop
        producerTransport = null;
    }

    for (const key in videoConsumers) {
        const consumer = videoConsumers[key];
        consumer.close();
        delete videoConsumers[key];
    }
    for (const key in audioConsumers) {
        const consumer = audioConsumers[key];
        consumer.close();
        delete audioConsumers[key];
    }

    if (consumerTransport) {
        consumerTransport.close();
        consumerTransport = null;
    }

    removeAllRemoteVideo();

    disconnectSocket();
    updateButtons();
}

async function loadDevice(routerRtpCapabilities) {
    try {
        device = new MediasoupClient.Device();
    } catch (error) {
        if (error.name === 'UnsupportedError') {
            console.error('browser not supported');
        }
    }
    await device.load({ routerRtpCapabilities });
}

function consumeAll(transport, remoteVideoIds, remotAudioIds) {
    console.log('----- consumeAll() -----')
    remoteVideoIds.forEach(rId => {
        consumeAdd(transport, rId, null, 'video');
    });
    remotAudioIds.forEach(rId => {
        consumeAdd(transport, rId, null, 'audio');
    });
};

async function consumeAdd(transport, remoteSocketId, prdId, trackKind) {
    console.log('--start of consumeAdd -- kind=%s', trackKind);
    const { rtpCapabilities } = device;
    //const data = await socket.request('consume', {rtpCapabilities});
    const data = await sendRequest('consumeAdd', { rtpCapabilities: rtpCapabilities, remoteId: remoteSocketId, kind: trackKind })
        .catch(err => {
            console.error('consumeAdd ERROR:', err);
        });
    const {
        producerId,
        id,
        kind,
        rtpParameters,
    } = data;
    if (prdId && (prdId !== producerId)) {
        console.warn('producerID NOT MATCH');
    }

    let codecOptions = {};
    const consumer = await transport.consume({
        id,
        producerId,
        kind,
        rtpParameters,
        codecOptions,
    });

    addRemoteTrack(remoteSocketId, consumer.track);
    addConsumer(remoteSocketId, consumer, kind);
    consumer.remoteId = remoteSocketId;
    consumer.on("transportclose", () => {
        console.log('--consumer transport closed. remoteId=' + consumer.remoteId);
    });
    consumer.on("producerclose", () => {
        console.log('--consumer producer closed. remoteId=' + consumer.remoteId);
        consumer.close();
        removeConsumer(remoteId, kind);
        removeRemoteVideo(consumer.remoteId);
    });
    consumer.on('trackended', () => {
        console.log('--consumer trackended. remoteId=' + consumer.remoteId);
    });

    console.log('--end of consumeAdd');

    console.log('--try resumeAdd --');
    sendRequest('resumeAdd', { remoteId: remoteSocketId, kind: kind })
        .then(() => {
            console.log('resumeAdd OK');
        })
        .catch(err => {
            console.error('resumeAdd ERROR:', err);
        });
}


function getConsumer(id, kind) {
    if (kind === 'video') {
        return videoConsumers[id];
    }
    else if (kind === 'audio') {
        return audioConsumers[id];
    }
    else {
        console.warn('UNKNOWN consumer kind=' + kind);
    }
}

function addConsumer(id, consumer, kind) {
    if (kind === 'video') {
        videoConsumers[id] = consumer;
        console.log('videoConsumers count=' + Object.keys(videoConsumers).length);
    }
    else if (kind === 'audio') {
        audioConsumers[id] = consumer;
        console.log('audioConsumers count=' + Object.keys(audioConsumers).length);
    }
    else {
        console.warn('UNKNOWN consumer kind=' + kind);
    }
}

function removeConsumer(id, kind) {
    if (kind === 'video') {
        delete videoConsumers[id];
        console.log('videoConsumers count=' + Object.keys(videoConsumers).length);
    }
    else if (kind === 'audio') {
        delete audioConsumers[id];
        console.log('audioConsumers count=' + Object.keys(audioConsumers).length);
    }
    else {
        console.warn('UNKNOWN consumer kind=' + kind);
    }
}

// ---- UI control ----
function updateButtons() {
    if (localStream) {
        disableElement('start_video_button');
        if (isSocketConnected()) {
            disableElement('stop_video_button');
            disableElement('room_name');
            disableElement('connect_button');
            enabelElement('disconnect_button');
            enabelElement('start_recording');
        }
        else {
            enabelElement('stop_video_button');
            enabelElement('room_name');
            enabelElement('connect_button');
            disableElement('disconnect_button');
        }
    }
    else {
        enabelElement('start_video_button');
        disableElement('stop_video_button');
        enabelElement('room_name');
        disableElement('connect_button');
        disableElement('disconnect_button');
    }
}

function enabelElement(id) {
    let element = document.getElementById(id);
    if (element) {
        element.removeAttribute('disabled');
    }
}

function disableElement(id) {
    let element = document.getElementById(id);
    if (element) {
        element.setAttribute('disabled', '1');
    }
}

// ===== Recording and sending data ====

function startRecording() {
    // use MediaStream Recording API
    recorder = new MediaRecorder(localStream, { mimeType: 'video/webm;codecs=vp9' });
    let counter = 0;

    // fires every one second and passes an BlobEvent
    recorder.ondataavailable = event => {
        socket.emit('recording data', { chunk: event.data, counter: counter }); // send data
        console.log('data available');
    };
    recorder.onstop = event => {
        console.log('Record stoped');
        if (isRecording) {
            socket.emit('recording continue', { chunk: event.data, counter: counter }); // send data
            counter++;
            recorder.start(1000);
        }
    }
    // make data available event fire every one second
    recorder.start(1000);
    isRecording = true;
    console.log('Start recording');
    enabelElement('stop_recording');
}

function stopRecording() {
    isRecording = false;
    recorder.stop();
}

setupRoomFromUrl();
updateButtons();
console.log('=== ready ===');