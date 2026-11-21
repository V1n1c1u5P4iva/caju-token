// Uso: npx hardhat run scripts/deploy.js --network sepolia
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;

  console.log(`Rede: ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Saldo: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`Tesouraria: ${treasury}\n`);

  const Caju = await ethers.getContractFactory("CajuToken");
  const caju = await Caju.deploy(treasury);
  const tx = caju.deploymentTransaction();
  console.log(`Hash do deploy: ${tx.hash}`);
  await caju.waitForDeployment();
  const receipt = await tx.wait(network.name === "sepolia" ? 3 : 1);

  const address = await caju.getAddress();
  const gasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice;
  const custo = receipt.gasUsed * gasPrice;
  const explorer = network.name === "sepolia" ? `https://sepolia.etherscan.io` : "";

  console.log(`\nCajuToken implantado em: ${address}`);
  console.log(`Bloco: ${receipt.blockNumber}`);
  console.log(`Gas usado: ${receipt.gasUsed}`);
  console.log(`Preço do gas: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`Custo do deploy: ${ethers.formatEther(custo)} ETH`);
  if (explorer) {
    console.log(`Contrato: ${explorer}/address/${address}`);
    console.log(`Transação: ${explorer}/tx/${tx.hash}`);
  }

  // Salva informações para o relatório e para o frontend
  const info = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 31337),
    address,
    deployTx: tx.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    gasPriceGwei: ethers.formatUnits(gasPrice, "gwei"),
    costEth: ethers.formatEther(custo),
    deployer: deployer.address,
    treasury,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployment.json"), JSON.stringify(info, null, 2));

  const artifact = await hre.artifacts.readArtifact("CajuToken");
  const out = path.join(__dirname, "..", "frontend", "src", "contract.json");
  fs.writeFileSync(out, JSON.stringify({ address, chainId: info.chainId, deployBlock: receipt.blockNumber, abi: artifact.abi }, null, 2));
  console.log(`\nEndereço e ABI gravados em frontend/src/contract.json`);

  if (network.name === "sepolia" && process.env.ETHERSCAN_API_KEY) {
    console.log("\nVerificando no Etherscan...");
    try {
      await hre.run("verify:verify", { address, constructorArguments: [treasury] });
    } catch (err) {
      console.log(`Verificação falhou (rode depois: npx hardhat verify --network sepolia ${address} ${treasury}):`, err.message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
