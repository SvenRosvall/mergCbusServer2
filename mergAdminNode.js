const winston = require('./config/winston.js')		// use config from root instance
const net = require('net')
const jsonfile = require('jsonfile')
let cbusLib = require('cbuslibrary')
const EventEmitter = require('events').EventEmitter;


function pad(num, len) { //add zero's to ensure hex values have correct number of characters
    let padded = "00000000" + num;
    return padded.substr(-len);
}

function decToHex(num, len) {
    return parseInt(num).toString(16).toUpperCase().padStart(len, '0');
}

class cbusAdmin extends EventEmitter {
    constructor(LAYOUT_PATH, NET_ADDRESS, NET_PORT) {
        super();
//        const setup = jsonfile.readFileSync(LAYOUT_PATH  + 'nodeConfig.json')
        this.configFile = 'config/' + LAYOUT_PATH + '/nodeConfig.json'
        this.config = jsonfile.readFileSync(this.configFile)
        const merg = jsonfile.readFileSync('./config/mergConfig.json')
//        super();
        this.merg = merg
        winston.info({message: `AdminNode : Config = ${this.configFile}`});
        //winston.debug({message: `merg- 32 :${JSON.stringify(this.merg['modules'][32]['name'])}`});
//        this.config = setup
//        this.configFile = LAYOUT_PATH + 'nodeConfig.json'
        this.pr1 = 2
        this.pr2 = 3
        this.canId = 60
        this.config.nodes = {}
        this.config.events = {}
        this.cbusErrors = {}
        this.cbusNoSupport = {}
        this.dccSessions = {}
        this.saveConfig()
        const outHeader = ((((this.pr1 * 4) + this.pr2) * 128) + this.canId) << 5
        this.header = ':S' + outHeader.toString(16).toUpperCase() + 'N'
        this.client = new net.Socket()
        this.client.connect(NET_PORT, NET_ADDRESS, function () {
            winston.info({message: `AdminNode Connected - ${NET_ADDRESS} on ${NET_PORT}`});
        })
        this.client.on('data', function (data) { //Receives packets from network and process individual Messages
            //const outMsg = data.toString().split(";")
            let indata = data.toString().replace(/}{/g, "}|{")
            //winston.info({message: `AdminNode CBUS Receive <<<  ${indata}`})
            const outMsg = indata.toString().split("|")
            //const outMsg = JSON.parse(data)
            //winston.info({message: `AdminNode Split <<<  ${outMsg.length}`})
            for (let i = 0; i < outMsg.length; i++) {

                //let cbusMsg = cbusLib.decode(outMsg[i].concat(";"))     // replace terminator removed by 'split' method
                winston.info({message: `AdminNode JSON Action >>>  ${outMsg[i]}`})
                //this.emit('cbusTraffic', {direction: 'In', raw: cbusMsg.encoded, translated: cbusMsg.text});
                this.action_message(JSON.parse(outMsg[i]))

            }
            //this.action_message(outMsg)
        }.bind(this))
        this.client.on('error', (err) => {
            winston.debug({message: 'TCP ERROR ${err.code}'});
        })
        this.client.on('close', function () {
            winston.debug({message: 'Connection Closed'});
            setTimeout(() => {
                this.client.connect(NET_PORT, NET_ADDRESS, function () {
                    winston.debug({message: 'Client ReConnected'});
                })
            }, 1000)
        }.bind(this))
        this.actions = { //actions when Opcodes are received
            '00': (cbusMsg) => { // ACK
                winston.info({message: "ACK (00) : No Action"});
            },
            '21': (cbusMsg) => { // KLOC
                winston.info({message: `Session Cleared : ${cbusMsg.session}`});
                let ref = cbusMsg.opCode
                let session = cbusMsg.session
                if (session in this.dccSessions) {
                    this.dccSessions[session].status = 'In Active'
                } else {
                    winston.debug({message: `Session ${session} does not exist - adding`});
                    this.dccSessions[session] = {}
                    this.dccSessions[session].count = 1
                    this.dccSessions[session].status = 'In Active'
                    this.cbusSend(this.QLOC(session))
                }
                this.emit('dccSessions', this.dccSessions)
            },
            '23': (cbusMsg) => { // DKEEP
                //winston.debug({message: `Session Keep Alive : ${cbusMsg.session}`});
                let ref = cbusMsg.opCode
                let session = cbusMsg.session

                if (session in this.dccSessions) {
                    this.dccSessions[session].count += 1
                    this.dccSessions[session].status = 'Active'
                } else {

                    winston.debug({message: `Session ${session} does not exist - adding`});

                    this.dccSessions[session] = {}
                    this.dccSessions[session].count = 1
                    this.dccSessions[session].status = 'Active'
                    this.cbusSend(this.QLOC(session))
                }
                this.emit('dccSessions', this.dccSessions)
            },

            '47': (cbusMsg) => { // DSPD
                let session = cbusMsg.session
                let speed = cbusMsg.speed
                let direction = cbusMsg.direction
                winston.info({message: `(47) DCC Speed Change : ${session} : ${direction} : ${speed}`});

                if (!(session in this.dccSessions)) {
                    this.dccSessions[session] = {}
                    this.dccSessions[session].count = 0
                }

                this.dccSessions[session].direction = direction
                this.dccSessions[session].speed = speed
                this.emit('dccSessions', this.dccSessions)
                //this.cbusSend(this.QLOC(session))
            },
            '50': (cbusMsg) => {// RQNN -  Node Number
                this.emit('requestNodeNumber')
            },
            '52': (cbusMsg) => {
                winston.debug({message: "NNACK (59) : " + cbusMsg.text});
            },
            '59': (cbusMsg) => {
                winston.debug({message: "WRACK (59) : " + cbusMsg.text});
            },
            '60': (cbusMsg) => {
                let session = cbusMsg.session
                if (!(session in this.dccSessions)) {
                    this.dccSessions[session] = {}
                    this.dccSessions[session].count = 0
                }
                let functionRange = cbusMsg.Fn1
                let dccNMRA = cbusMsg.Fn2
                let func = `F${functionRange}`
                this.dccSessions[session][func] = dccNMRA
                let functionArray = []
                if (this.dccSessions[session].F1 & 1) functionArray.push(1)
                if (this.dccSessions[session].F1 & 2) functionArray.push(2)
                if (this.dccSessions[session].F1 & 4) functionArray.push(3)
                if (this.dccSessions[session].F1 & 8) functionArray.push(4)
                if (this.dccSessions[session].F2 & 1) functionArray.push(5)
                if (this.dccSessions[session].F2 & 2) functionArray.push(6)
                if (this.dccSessions[session].F2 & 4) functionArray.push(7)
                if (this.dccSessions[session].F2 & 8) functionArray.push(8)
                if (this.dccSessions[session].F3 & 1) functionArray.push(9)
                if (this.dccSessions[session].F3 & 2) functionArray.push(10)
                if (this.dccSessions[session].F3 & 4) functionArray.push(11)
                if (this.dccSessions[session].F3 & 8) functionArray.push(12)
                if (this.dccSessions[session].F4 & 1) functionArray.push(13)
                if (this.dccSessions[session].F4 & 2) functionArray.push(14)
                if (this.dccSessions[session].F4 & 4) functionArray.push(15)
                if (this.dccSessions[session].F4 & 8) functionArray.push(16)
                if (this.dccSessions[session].F4 & 16) functionArray.push(17)
                if (this.dccSessions[session].F4 & 32) functionArray.push(18)
                if (this.dccSessions[session].F4 & 64) functionArray.push(19)
                if (this.dccSessions[session].F4 & 128) functionArray.push(20)
                if (this.dccSessions[session].F5 & 1) functionArray.push(21)
                if (this.dccSessions[session].F5 & 2) functionArray.push(22)
                if (this.dccSessions[session].F5 & 4) functionArray.push(23)
                if (this.dccSessions[session].F5 & 8) functionArray.push(24)
                if (this.dccSessions[session].F5 & 16) functionArray.push(25)
                if (this.dccSessions[session].F5 & 32) functionArray.push(26)
                if (this.dccSessions[session].F5 & 64) functionArray.push(27)
                if (this.dccSessions[session].F5 & 128) functionArray.push(28)
                this.dccSessions[session].functions = functionArray

                winston.debug({message: `DCC Set Engine Function : ${cbusMsg.session} ${functionRange} ${dccNMRA} : ${functionArray}`});
                this.emit('dccSessions', this.dccSessions)
                //this.cbusSend(this.QLOC(session))
            },
            '63': (cbusMsg) => {// ERR - dcc error
                //winston.debug({message: `DCC ERROR Node ${msg.nodeId()} Error ${msg.errorId()}`});
                let output = {}
                output['type'] = 'DCC'
                output['Error'] = cbusMsg.errorNumber
                output['Message'] = this.merg.dccErrors[cbusMsg.errorNumber]
                output['data'] = decToHex(cbusMsg.data1, 2) + decToHex(cbusMsg.data2, 2)
                this.emit('dccError', output)
            },
            '6F': (cbusMsg) => {// CMDERR - Cbus Error
                let ref = cbusMsg.nodeNumber.toString() + '-' + cbusMsg.errorNumber.toString()
                if (ref in this.cbusErrors) {
                    this.cbusErrors[ref].count += 1
                } else {
                    let output = {}
                    output['id'] = ref
                    output['type'] = 'CBUS'
                    output['Error'] = cbusMsg.errorNumber
                    output['Message'] = this.merg.cbusErrors[cbusMsg.errorNumber]
                    output['node'] = cbusMsg.nodeNumber
                    output['count'] = 1
                    this.cbusErrors[ref] = output
                }
                this.emit('cbusError', this.cbusErrors)
            },
            '74': (cbusMsg) => { // NUMEV
                //winston.info({message: 'AdminNode: 74: ' + JSON.stringify(this.config.nodes[cbusMsg.nodeNumber])})
                if (this.config.nodes[cbusMsg.nodeNumber].eventCount != null) {
                    if (this.config.nodes[cbusMsg.nodeNumber].eventCount != cbusMsg.eventCount) {
                        this.config.nodes[cbusMsg.nodeNumber].eventCount = cbusMsg.eventCount
                        this.saveConfig()
                    } else {
                        winston.debug({message: `AdminNode: NUMEV: EvCount value has not changed`});
                    }
                } else {
                    this.config.nodes[cbusMsg.nodeNumber].eventCount = cbusMsg.eventCount
                    this.saveConfig()
                }
                //winston.info({message: 'AdminNode: NUMEV: ' + JSON.stringify(this.config.nodes[cbusMsg.nodeNumber])});
            },
            '90': (cbusMsg) => {//Accessory On Long Event
                //winston.info({message: `AdminNode: 90 recieved`})
                this.eventSend(cbusMsg, 'on', 'long')
            },
            '91': (cbusMsg) => {//Accessory Off Long Event
                //winston.info({message: `AdminNode: 91 recieved`})
                this.eventSend(cbusMsg, 'off', 'long')
            },
            '97': (cbusMsg) => { // NVANS - Receive Node Variable Value
                if (this.config.nodes[cbusMsg.nodeNumber].nodeVariables[cbusMsg.nodeVariableIndex] != null) {
                    if (this.config.nodes[cbusMsg.nodeNumber].nodeVariables[cbusMsg.nodeVariableIndex] != cbusMsg.nodeVariableValue) {
                        winston.info({message: `Variable ${cbusMsg.nodeVariableIndex} value has changed`});
                        this.config.nodes[cbusMsg.nodeNumber].nodeVariables[cbusMsg.nodeVariableIndex] = cbusMsg.nodeVariableValue
                        this.saveConfig()
                    } else {
                        winston.info({message: `Variable ${cbusMsg.nodeVariableIndex} value has not changed`});
                    }
                } else {
                    winston.info({message: `Variable ${cbusMsg.nodeVariableIndex} value does not exist in config`});
                    this.config.nodes[cbusMsg.nodeNumber].nodeVariables[cbusMsg.nodeVariableIndex] = cbusMsg.nodeVariableValue
                    this.saveConfig()
                }
            },
            '98': (cbusMsg) => {//Accessory On Short Event
                this.eventSend(cbusMsg, 'on', 'short')
            },
            '99': (cbusMsg) => {//Accessory Off Short Event
                this.eventSend(cbusMsg, 'off', 'short')
            },
            '9B': (cbusMsg) => {//PARAN Parameter readback by Index
                let saveConfigNeeded = false
                if (cbusMsg.parameterIndex == 1) {
                    if (this.config.nodes[cbusMsg.nodeNumber].moduleManufacturerName != merg.moduleManufacturerName[cbusMsg.parameterValue]) {
                        this.config.nodes[cbusMsg.nodeNumber].moduleManufacturerName = merg.moduleManufacturerName[cbusMsg.parameterValue]
                        saveConfigNeeded = true
                    }
                }
                if (cbusMsg.parameterIndex == 9) {
                    if (this.config.nodes[cbusMsg.nodeNumber].cpuName != merg.cpuName[cbusMsg.parameterValue]) {
                        this.config.nodes[cbusMsg.nodeNumber].cpuName = merg.cpuName[cbusMsg.parameterValue]
                        saveConfigNeeded = true
                    }
                }
                if (cbusMsg.parameterIndex == 10) {
                    if (this.config.nodes[cbusMsg.nodeNumber].interfaceName != merg.interfaceName[cbusMsg.parameterValue]) {
                        this.config.nodes[cbusMsg.nodeNumber].interfaceName = merg.interfaceName[cbusMsg.parameterValue]
                        saveConfigNeeded = true
                    }
                }
                if (cbusMsg.parameterIndex == 19) {
                    if (this.config.nodes[cbusMsg.nodeNumber].cpuManufacturerName != merg.cpuManufacturerName[cbusMsg.parameterValue]) {
                        this.config.nodes[cbusMsg.nodeNumber].cpuManufacturerName = merg.cpuManufacturerName[cbusMsg.parameterValue]
                        saveConfigNeeded = true
                    }
                }
                if (this.config.nodes[cbusMsg.nodeNumber].parameters[cbusMsg.parameterIndex] !== null) {
                    if (this.config.nodes[cbusMsg.nodeNumber].parameters[cbusMsg.parameterIndex] != cbusMsg.parameterValue) {
                        winston.debug({message: `Parameter ${cbusMsg.parameterIndex} value has changed`});
                        this.config.nodes[cbusMsg.nodeNumber].parameters[cbusMsg.parameterIndex] = cbusMsg.parameterValue
                        saveConfigNeeded = true
                    } else {
                        winston.info({message: `Parameter ${cbusMsg.parameterIndex} value has not changed`});
                    }
                } else {
                    winston.info({message: `Parameter ${cbusMsg.parameterIndex} value does not exist in config`});
                    this.config.nodes[cbusMsg.nodeNumber].parameters[cbusMsg.parameterIndex] = cbusMsg.parameterValue
                    saveConfigNeeded = true
                }
                // ok, save the config if needed
                if (saveConfigNeeded == true) {
                    this.saveConfig()
                }
            },
            'B0': (cbusMsg) => {//Accessory On Long Event 1
                this.eventSend(cbusMsg, 'on', 'long')
            },
            'B1': (cbusMsg) => {//Accessory Off Long Event 1
                this.eventSend(cbusMsg, 'off', 'long')
            },
            'B5': (cbusMsg) => {// NEVAL -Read of EV value Response REVAL
                if (this.config.nodes[cbusMsg.nodeNumber].consumedEvents[cbusMsg.eventIndex] != null) {
                    if (this.config.nodes[cbusMsg.nodeNumber].consumedEvents[cbusMsg.eventIndex].variables[cbusMsg.eventVariableIndex] != null) {
                        if (this.config.nodes[cbusMsg.nodeNumber].consumedEvents[cbusMsg.eventIndex].variables[cbusMsg.eventVariableIndex] != cbusMsg.eventVariableValue) {
                            winston.debug({message: `Event Variable ${cbusMsg.variable} Value has Changed `});
                            this.config.nodes[cbusMsg.nodeNumber].consumedEvents[cbusMsg.eventIndex].variables[cbusMsg.eventVariableIndex] = cbusMsg.eventVariableValue
                            this.saveConfig()
                        } else {
                            winston.debug({message: `NEVAL: Event Variable ${cbusMsg.eventVariableIndex} Value has not Changed `});
                        }
                    } else {
                        winston.debug({message: `NEVAL: Event Variable ${cbusMsg.variable} Does not exist on config - adding`});
                        this.config.nodes[cbusMsg.nodeNumber].consumedEvents[cbusMsg.eventIndex].variables[cbusMsg.eventVariableIndex] = cbusMsg.eventVariableValue
                        this.saveConfig()
                    }
                } else {
                    winston.debug({message: `NEVAL: Event Index ${cbusMsg.eventIndex} Does not exist on config - skipping`});
                }
            },
            'B6': (cbusMsg) => { //PNN Recieved from Node
                const ref = cbusMsg.nodeNumber
                const moduleIdentifier = cbusMsg.encoded.toString().substr(13, 4)
                if (ref in this.config.nodes) {
                    winston.debug({message: `PNN (B6) Node found ` + JSON.stringify(this.config.nodes[ref])})
                    if (this.merg['modules'][moduleIdentifier]) {
                        this.config.nodes[ref].module = this.merg['modules'][moduleIdentifier]['name']
                        this.config.nodes[ref].component = this.merg['modules'][moduleIdentifier]['component']
                    } else {
                        this.config.nodes[ref].component = 'mergDefault'
                        this.config.nodes[ref].module = 'Unknown'
                    }
                } else {
                    let output = {
                        "nodeNumber": cbusMsg.nodeNumber,
                        "manufacturerId": cbusMsg.manufacturerId,
                        "moduleId": cbusMsg.moduleId,
                        "moduleIdentifier": moduleIdentifier,
                        "flags": cbusMsg.flags,
                        "consumer": false,
                        "producer": false,
                        "flim": false,
                        "bootloader": false,
                        "coe": false,
                        "parameters": [],
                        "nodeVariables": [],
                        "consumedEvents": {},
                        "status": true,
                        "eventCount": 0
                    }
                    if (this.merg['modules'][moduleIdentifier]) {
                        output['module'] = this.merg['modules'][moduleIdentifier]['name']
                        output['component'] = this.merg['modules'][moduleIdentifier]['component']
                    } else {
                        winston.info({message: `AdminNode Module Type ${cbusMsg.moduleId} not setup in  `})
                        output['component'] = 'mergDefault'
                        output['module'] = 'Unknown'
                    }
                    this.config.nodes[ref] = output
                }
                // always update the flags....
                this.config.nodes[ref].flags = cbusMsg.flags
                this.config.nodes[ref].flim = (cbusMsg.flags & 4) ? true : false
                this.config.nodes[ref].consumer = (cbusMsg.flags & 1) ? true : false
                this.config.nodes[ref].producer = (cbusMsg.flags & 2) ? true : false
                this.config.nodes[ref].bootloader = (cbusMsg.flags & 8) ? true : false
                this.config.nodes[ref].coe = (cbusMsg.flags & 16) ? true : false
                this.config.nodes[ref].learn = (cbusMsg.flags & 32) ? true : false
                this.config.nodes[ref].status = true
                this.cbusSend((this.RQEVN(cbusMsg.nodeNumber)))
                this.saveConfig()
            },
            'B8': (cbusMsg) => {//Accessory On Short Event 1
                this.eventSend(cbusMsg, 'on', 'short')
            },
            'B9': (cbusMsg) => {//Accessory Off Short Event 1
                this.eventSend(cbusMsg, 'off', 'short')
            },
            'D0': (cbusMsg) => {//Accessory On Long Event 2
                this.eventSend(cbusMsg, 'on', 'long')
            },
            'D1': (cbusMsg) => {//Accessory Off Long Event 2
                this.eventSend(cbusMsg, 'off', 'long')
            },
            'D8': (cbusMsg) => {//Accessory On Short Event 2
                this.eventSend(cbusMsg, 'on', 'short')
            },
            'D9': (cbusMsg) => {//Accessory Off Short Event 2
                this.eventSend(cbusMsg, 'off', 'short')
            },
            'E1': (cbusMsg) => { // PLOC
                let session = cbusMsg.session
                if (!(session in this.dccSessions)) {
                    this.dccSessions[session] = {}
                    this.dccSessions[session].count = 0
                }
                this.dccSessions[session].id = session
                this.dccSessions[session].loco = cbusMsg.address
                this.dccSessions[session].direction = cbusMsg.direction
                this.dccSessions[session].speed = cbusMsg.speed
                this.dccSessions[session].status = 'Active'
                this.dccSessions[session].F1 = cbusMsg.Fn1
                this.dccSessions[session].F2 = cbusMsg.Fn2
                this.dccSessions[session].F3 = cbusMsg.Fn3
                this.emit('dccSessions', this.dccSessions)
                winston.debug({message: `PLOC (E1) ` + JSON.stringify(this.dccSessions[session])})
            },
            'EF': (cbusMsg) => {//Request Node Parameter in setup
                // mode
                //winston.debug({message: `PARAMS (EF) Received`});
            },
            'F0': (cbusMsg) => {//Accessory On Long Event 3
                this.eventSend(cbusMsg, 'on', 'long')
            },
            'F1': (cbusMsg) => {//Accessory Off Long Event 3
                this.eventSend(cbusMsg, 'off', 'long')
            },
            'F2': (cbusMsg) => {//ENSRP Response to NERD/NENRD
                // ENRSP Format: [<MjPri><MinPri=3><CANID>]<F2><NN hi><NN lo><EN3><EN2><EN1><EN0><EN#>
                //winston.debug({message: `ENSRP (F2) Response to NERD : Node : ${msg.nodeId()} Action : ${msg.actionId()} Action Number : ${msg.actionEventId()}`});
                const ref = cbusMsg.eventIndex
                if (!(ref in this.config.nodes[cbusMsg.nodeNumber].consumedEvents)) {
                    this.config.nodes[cbusMsg.nodeNumber].consumedEvents[cbusMsg.eventIndex] = {
                        "eventIdentifier": cbusMsg.eventIdentifier,
                        "eventIndex": cbusMsg.eventIndex,
                        "node": cbusMsg.nodeNumber,
                        "variables": []
                    }
                    if (this.config.nodes[cbusMsg.nodeNumber].module == "CANMIO") {
                        //winston.info({message:`ENSRP CANMIO: ${cbusMsg.nodeNumber} :: ${cbusMsg.eventIndex}`})
                        //if (["CANMIO","LIGHTS"].includes(this.config.nodes[cbusMsg.nodeNumber].module)){
                        /*setTimeout(() => {
                            this.cbusSend(this.REVAL(cbusMsg.nodeNumber, cbusMsg.eventIndex, 0))
                        }, 10 * ref)*/
                        setTimeout(() => {
                            this.cbusSend(this.REVAL(cbusMsg.nodeNumber, cbusMsg.eventIndex, 1))
                        }, 20 * ref)
                    }
                    if (this.config.nodes[cbusMsg.nodeNumber].module == "LIGHTS") {
                        setTimeout(() => {
                            this.cbusSend(this.REVAL(cbusMsg.nodeNumber, cbusMsg.eventIndex, 1))
                        }, 100 * ref)
                    }
                    this.saveConfig()
                }
                //this.saveConfig()
            },
            'F8': (cbusMsg) => {//Accessory On Short Event 3
                this.eventSend(cbusMsg, 'on', 'short')
            },
            'F9': (cbusMsg) => {//Accessory Off Short Event 3
                this.eventSend(cbusMsg, 'off', 'short')
            },
            'DEFAULT': (cbusMsg) => {
                winston.debug({message: "Opcode " + cbusMsg.opCode + ' is not supported by the Admin module'});
                let ref = cbusMsg.opCode

                if (ref in this.cbusNoSupport) {
                    this.cbusNoSupport[ref].cbusMsg = cbusMsg
                    this.cbusNoSupport[ref].count += 1
                } else {
                    let output = {}
                    output['opCode'] = cbusMsg.opCode
                    output['msg'] = {"message": cbusMsg.encoded}
                    output['count'] = 1
                    this.cbusNoSupport[ref] = output
                }
                this.emit('cbusNoSupport', this.cbusNoSupport)
            }
        }
        this.cbusSend(this.QNN())
    }

    action_message(cbusMsg) {
        winston.info({message: "AdminNode Opcode " + cbusMsg.opCode + ' processed'});
        if (this.actions[cbusMsg.opCode]) {
            this.actions[cbusMsg.opCode](cbusMsg);
        } else {
            this.actions['DEFAULT'](cbusMsg);
        }
    }

    removeNodeEvents(nodeId) {
        this.config.nodes[nodeId].consumedEvents = {}
        this.saveConfig()
    }

    removeNode(nodeId) {
        delete this.config.nodes[nodeId]
        this.saveConfig()
    }

    removeEvent(eventId) {
        delete this.config.events[eventId]
        this.saveConfig()
    }

    clearCbusErrors() {
        this.cbusErrors = {}
        this.emit('cbusError', this.cbusErrors)
    }

    cbusSend(msg) {
        if (typeof msg !== 'undefined') {
            //winston.info({message: `AdminNode cbusSend Base : ${JSON.stringify(msg)}`});
            let output = JSON.stringify(msg)
            this.client.write(output);


            //let outMsg = cbusLib.decode(msg);
            //this.emit('cbusTraffic', {direction: 'Out', raw: outMsg.encoded, translated: outMsg.text});
            winston.info({message: `AdminNode CBUS send >> ${output} `});
        }

    }

    refreshEvents() {
        this.emit('events', Object.values(this.config.events))
    }

    clearEvents() {
        winston.info({message: `clearEvents() `});
        this.config.events = {}
        this.saveConfig()
        this.emit('events', this.config.events)
    }

    eventSend(cbusMsg, status, type) {
        let eId = cbusMsg.encoded.substr(9, 8)
        //let eventId = ''
        if (type == 'short') {
            //cbusMsg.msgId = decToHex(cbusMsg.nodeNumber,4) + decToHex(cbusMsg.eventNumber,4)
            eId = "0000" + eId.slice(4)
        }
        if (eId in this.config.events) {
            this.config.events[eId]['status'] = status
            this.config.events[eId]['count'] += 1
            //this.config.events[cbusMsg.msgId]['data'] = cbusMsg.eventData.hex
        } else {
            let output = {}
            output['id'] = eId
            output['nodeNumber'] = cbusMsg.nodeNumber
            if (type == 'short') {
                output['eventNumber'] = cbusMsg.deviceNumber
            } else {
                output['eventNumber'] = cbusMsg.eventNumber
            }
            output['status'] = status
            output['type'] = type
            output['count'] = 1
            //output['data'] = cbusMsg.eventData.hex
            this.config.events[eId] = output
        }
        winston.info({message: 'AdminNode: EventSend : ' + JSON.stringify(this.config.events[eId])});
        //this.saveConfig()
        this.emit('events', this.config.events);
    }


    saveConfig() {
        //winston.debug({message: `Save Config `});
        //this.config.events = this.events
        //
        //
        //
        winston.info({message: 'AdminNode: Save Config : '});
        jsonfile.writeFileSync(this.configFile, this.config, {spaces: 2, EOL: '\r\n'})
        //let nodes = []
        /*for (let node in this.config.nodes){
            nodes.push(this.config.nodes[node])
        }*/
        this.emit('nodes', this.config.nodes);
        //this.emit('nodes', Object.values(this.config.nodes))
    }

    QNN() {//Query Node Number
        winston.info({message: 'AdminNode: QNN '})
        for (let node in this.config.nodes) {
            this.config.nodes[node].status = false
        }
        let output = {}
        output['mnemonic'] = 'QNN'
        return output;
    }

    RQNP() {//Request Node Parameters
        return cbusLib.encodeRQNP();
    }

    RQNPN(nodeId, param) {//Read Node Parameter
        let output = {}
        output['mnemonic'] = 'RQNPN'
        output['nodeNumber'] = nodeId
        output['parameterIndex'] = param
        return output
        //return cbusLib.encodeRQNPN(nodeId, param);
    }

    NNLRN(nodeId) {

        if (nodeId >= 0 && nodeId <= 0xFFFF) {
            let output = {}
            output['mnemonic'] = 'NNLRN'
            output['nodeNumber'] = nodeId
            return output
            //return cbusLib.encodeNNLRN(nodeId);
        }

    }

    NNULN(nodeId) {
        let output = {}
        output['mnemonic'] = 'NNULN'
        output['nodeNumber'] = nodeId
        return output
        //return cbusLib.encodeNNULN(nodeId);
    }

    SNN(nodeId) {
        if (nodeId >= 0 && nodeId <= 0xFFFF) {
            let output = {}
            output['mnemonic'] = 'SNN'
            output['nodeNumber'] = nodeId
            return output
            //return cbusLib.encodeSNN(nodeId);
        }
    }

    NERD(nodeId) {//Request All Events
        let output = {}
        output['mnemonic'] = 'NERD'
        output['nodeNumber'] = nodeId
        return output
    }

    NENRD(nodeId, eventId) { //Request specific event
        return cbusLib.encodeNENRD(nodeId, eventId);
    }

    REVAL(nodeId, eventId, valueId) {//Read an Events EV by index
        //winston.info({message: 'AdminNode: REVAL '})
        let output = {}
        output['mnemonic'] = 'REVAL'
        output['nodeNumber'] = nodeId
        output['eventIndex'] = eventId
        output['eventVariableIndex'] = valueId
        return output;
        //return cbusLib.encodeREVAL(nodeId, eventId, valueId);
    }

    update_event(nodeId, event, eventIndex, variableId, value){
        this.config.nodes[nodeId].consumedEvents[eventIndex].variables[variableId] = value
        return this.EVLRN(nodeId, event, variableId, value)
    }

    teach_event(nodeId, event, variableId, value) {
        return this.EVLRN(nodeId, event, variableId, value)
    }

    EVLRN(nodeId, event, variableId, value) {//Update Event Variable
        //let nodeNumber = parseInt(event.substr(0, 4), 16)
        //winston.info({message: `AdminNode: EVLRN ${event} ${eventIndex} ${variableId} ${value} ` })
        //winston.info({message: `Test ${JSON.stringify(this.config.nodes[nodeId])}` })
        //this.config.nodes[nodeId].consumedEvents[eventIndex].variables[variableId] = value
        //this.config.nodes[parseInt(event.substr(0, 4), 16)].consumedEvents[eventIndex].variables[variableId] = value
        //this.saveConfig()
        let output = {}
        output['mnemonic'] = 'EVLRN'
        output['nodeNumber'] = parseInt(event.substr(0, 4), 16)
        output['eventNumber'] = parseInt(event.substr(4, 4), 16)
        output['eventVariableIndex'] = variableId
        output['eventVariableValue'] = value
        return output;
        //return cbusLib.encodeEVLRN(parseInt(event.substr(0, 4), 16), parseInt(event.substr(4, 4), 16), variableId, valueId);
    }

    EVULN(event) {//Remove an Event in Learn mMode
        let output = {}
        output['mnemonic'] = 'EVULN'
        output['nodeNumber'] = parseInt(event.substr(0, 4), 16)
        output['eventNumber'] = parseInt(event.substr(4, 4), 16)
        return output
        //return cbusLib.encodeEVULN(parseInt(event.substr(0, 4), 16), parseInt(event.substr(4, 4), 16));

    }

    NVRD(nodeId, variableId) {// Read Node Variable
        let output = {}
        output['mnemonic'] = 'NVRD'
        output['nodeNumber'] = nodeId
        output['nodeVariableIndex'] = variableId
        winston.info({message: `AdminNode: NVRD : ${nodeId} :${JSON.stringify(output)}`})
        return output
        //return cbusLib.encodeNVRD(nodeId, variableId);
    }

    RQEVN(nodeId) {// Read Node Variable

        let output = {}
        output['mnemonic'] = 'RQEVN'
        output['nodeNumber'] = nodeId
        //winston.info({message: `AdminNode: RQEVN : ${nodeId} :${JSON.stringify(output)}`})
        return output;
        //return cbusLib.encodeRQEVN(nodeId);
    }

    NVSET(nodeId, variableId, variableVal) {// Read Node Variable
        this.config.nodes[nodeId].nodeVariables[variableId] = variableVal
        this.saveConfig()
        let output = {}
        output['mnemonic'] = 'NVSET'
        output['nodeNumber'] = nodeId
        output['nodeVariableIndex'] = variableId
        output['nodeVariableValue'] = variableVal
        winston.info({message: `AdminNode: NVSET : ${nodeId} :${JSON.stringify(output)}`})
        return output

        //return cbusLib.encodeNVSET(nodeId, variableId, variableVal);

    }

    ACON(nodeId, eventId) {
        const eId = decToHex(nodeId, 4) + decToHex(eventId, 4)
        //winston.debug({message: `ACON admin ${eId}`});
        let output = {}
        if (eId in this.config.events) {
            this.config.events[eId]['status'] = 'on'
            this.config.events[eId]['count'] += 1
        } else {
            output['id'] = eId
            output['nodeId'] = nodeId
            output['eventId'] = eventId
            output['status'] = 'on'
            output['type'] = 'long'
            output['count'] = 1
            this.config.events[eId] = output
        }
        this.emit('events', Object.values(this.config.events))
        output = {}
        output['mnemonic'] = 'ACON'
        output['nodeNumber'] = nodeId
        output['eventNumber'] = eventId
        return output
        //return cbusLib.encodeACON(nodeId, eventId);
    }

    ACOF(nodeId, eventId) {
        const eId = decToHex(nodeId, 4) + decToHex(eventId, 4)
        //winston.debug({message: `ACOF admin ${eId}`});
        let output = {}
        if (eId in this.config.events) {
            this.config.events[eId]['status'] = 'off'
            this.config.events[eId]['count'] += 1
        } else {
            output['id'] = eId
            output['nodeId'] = nodeId
            output['eventId'] = eventId
            output['status'] = 'off'
            output['type'] = 'long'
            output['count'] = 1
            this.config.events[eId] = output
        }
        //this.config.events[eId]['status'] = 'off'
        //this.config.events[eId]['count'] += 1
        this.emit('events', Object.values(this.config.events))
        output = {}
        output['mnemonic'] = 'ACOF'
        output['nodeNumber'] = nodeId
        output['eventNumber'] = eventId
        return output
        //return cbusLib.encodeACOF(nodeId, eventId);
    }

    ASON(nodeId, deviceNumber) {
        const eId = decToHex(nodeId, 4) + decToHex(deviceNumber, 4)
        //winston.debug({message: `ASON admin ${eId}`});
        let output = {}
        if (eId in this.config.events) {
            this.config.events[eId]['status'] = 'on'
            this.config.events[eId]['count'] += 1
        } else {
            output['id'] = eId
            output['nodeId'] = nodeId
            output['eventId'] = deviceNumber
            output['status'] = 'on'
            output['type'] = 'short'
            output['count'] = 1
            this.config.events[eId] = output
        }
        this.emit('events', Object.values(this.config.events))
        output = {}
        output['mnemonic'] = 'ASON'
        output['nodeNumber'] = nodeId
        output['deviceNumber'] = deviceNumber
        return output

        //Format: [<MjPri><MinPri=3><CANID>]<98><NN hi><NN lo><DN hi><DN lo>
        //return cbusLib.encodeASON(nodeId, deviceNumber);

    }

    ASOF(nodeId, deviceNumber) {
        const eId = decToHex(nodeId, 4) + decToHex(deviceNumber, 4)
        //winston.debug({message: `ASOFadmin ${eId}`});
        let output = {}
        if (eId in this.config.events) {
            this.config.events[eId]['status'] = 'off'
            this.config.events[eId]['count'] += 1
        } else {
            output['id'] = eId
            output['nodeId'] = nodeId
            output['eventId'] = deviceNumber
            output['status'] = 'off'
            output['type'] = 'short'
            output['count'] = 1
            this.config.events[eId] = output
        }
        this.emit('events', Object.values(this.config.events))
        output = {}
        output['mnemonic'] = 'ASOF'
        output['nodeNumber'] = nodeId
        output['deviceNumber'] = deviceNumber
        return output
        //Format: [<MjPri><MinPri=3><CANID>]<99><NN hi><NN lo><DN hi><DN lo>
        //return cbusLib.encodeASOF(nodeId, deviceNumber);

    }

    QLOC(sessionId) {
        return cbusLib.encodeQLOC(sessionId);
    }

    /*ENRSP() {
        let output = '';
		winston.debug({message: `ENRSP : ${Object.keys(this.events).length}`});
        const eventList = Object.keys(this.events)
        for (let i = 0, len = eventList.length; i < len; i++) {
            output += this.header + 'F2' + pad(this.nodeId.toString(16), 4) + eventList[i] + pad((i+1).toString(16), 2) + ';'
			winston.debug({message: `ENSRP output : ${output}`});
        }
        return output
    }*/

    /*PNN() {
        return this.header + 'B6' + pad(this.nodeId.toString(16), 4) + pad(this.manufId.toString(16), 2) + pad(this.moduleId.toString(16), 2) + pad(this.flags(16), 2) + ';'

    }

    PARAMS() {
        var par = this.params();
		//winston.debug({message: 'RQNPN :'+par[index]});
        let output = this.header + 'EF'
        for (var i = 1; i < 8; i++) {
            output += par[i]
        }
        output += ';'
        return output;

    }

    RQNN() {
		winston.debug({message: `RQNN TM : ${this.TEACH_MODE ? 'TRUE' : 'FALSE'}`});
        return this.header + '50' + pad(this.nodeId.toString(16), 4) + ';';
    }

    NNACK() {
        return this.header + '52' + pad(this.nodeId.toString(16), 4) + ';';
    }

    WRACK() {
        return this.header + '59' + pad(this.nodeId.toString(16), 4) + ';';
    }

    NUMEV() {
        return this.header + '74' + pad(this.nodeId.toString(16), 4) + pad(Object.keys(this.events).length.toString(16), 2) + ';';
        //object.keys(this.events).length
    }

    NEVAL(eventIndex, eventNo) {
        const eventId = Object.keys(this.events)[eventIndex-1]
		winston.debug({message: `NEVAL ${eventId} : ${eventIndex} : ${eventNo} -- ${Object.keys(this.events)}`});
        return this.header + 'B5' + pad(this.nodeId.toString(16), 4) + pad(eventIndex.toString(16), 2) + pad(eventNo.toString(16), 2)+ pad(this.events[eventId][eventNo].toString(16), 2) + ';'
    }

    ENRSP() {
        let output = '';
		winston.debug({message: `ENRSP : ${Object.keys(this.events).length}`});
        const eventList = Object.keys(this.events)
        for (let i = 0, len = eventList.length; i < len; i++) {
            output += this.header + 'F2' + pad(this.nodeId.toString(16), 4) + eventList[i] + pad((i+1).toString(16), 2) + ';'
			winston.debug({message: `ENSRP output : ${output}`});
        }
        return output
    }

    PARAN(index) {
        const par = this.params();
		//winston.debug({message: 'RQNPN :'+par[index]});
        return this.header + '9B' + pad(this.nodeId.toString(16), 4) + pad(index.toString(16), 2) + pad(par[index].toString(16), 2) + ';';
    }

    NVANS(index) {
        return this.header + '97' + pad(this.nodeId.toString(16), 4) + pad(index.toString(16), 2) + pad(this.variables[index].toString(16), 2) + ';';
    }

    NAME() {
        let name = this.name + '       '
        let output = ''
        for (let i = 0; i < 7; i++) {
            output = output + pad(name.charCodeAt(i).toString(16), 2)
        }
        return this.header + 'E2' + output + ';'
    }

    */
};


module.exports = {
    cbusAdmin: cbusAdmin
}


