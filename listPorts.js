const { SerialPort } = require("serialport")

// list serial ports:
SerialPort.list().then(ports => {
  ports.forEach(function(port) {
    if (port.vendorId == '04d8' && port.productId == 'f80c') {
      console.log('PORT :' + port.path);
      console.log('PNP  :' + port.pnpId);
      console.log('Manufacturer  :' + port.manufacturer);
      console.log('COM  :' + port.path);
      console.log('Vender  :' + port.vendorId);
      console.log('Product  :' + port.productId);
      console.log('Serial  :' + port.serialNumber);
    }
  });
});
