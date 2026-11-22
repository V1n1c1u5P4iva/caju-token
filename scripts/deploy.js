// Uso: npx hardhat run scripts/deploy.js --network sepolia
//
// Fluxo do script:
//   1. pega a carteira que assina o deploy e define a tesouraria;
//   2. implanta o CajuToken e espera confirmações;
//   3. calcula o custo real (gas usado × preço do gas);
//   4. grava deployment.json (relatório) e frontend/src/contract.json (endereço + ABI);
//   5. verifica o código-fonte no Etherscan.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  // Signer: a conta que assina e paga o deploy. Na Sepolia é a PRIVATE_KEY do .env;
  // na rede local é a conta #0 do Hardhat. O constructor do contrato dá a ela todos os
  // papéis (admin, minter, pauser, compliance) e 70% do supply inicial.
  const [deployer] = await ethers.getSigners();
  // Tesouraria: recebe 30% do supply inicial e as taxas de transferência. Usar uma carteira
  // separada (TREASURY_ADDRESS) deixa visível na demonstração a taxa saindo para outra conta;
  // se não for informada, a própria carteira do deployer faz esse papel.
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;

  // Mostra o saldo antes do deploy para conferir se há ETH de teste suficiente para o gas.
  console.log(`Rede: ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Saldo: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`Tesouraria: ${treasury}\n`);

  // A factory usa o bytecode compilado em artifacts/; o argumento vai para o constructor(treasury_).
  const Caju = await ethers.getContractFactory("CajuToken");
  const caju = await Caju.deploy(treasury);
  const tx = caju.deploymentTransaction();
  console.log(`Hash do deploy: ${tx.hash}`);
  await caju.waitForDeployment();
  // Na Sepolia espera 3 blocos de confirmação: além de reduzir o risco de reorganização da
  // cadeia, dá tempo para o Etherscan indexar o contrato, senão a verificação logo abaixo
  // costuma falhar com "contrato não encontrado". Localmente 1 bloco basta.
  const receipt = await tx.wait(network.name === "sepolia" ? 3 : 1);

  // Custo real = gas efetivamente consumido × preço pago por unidade de gas (em wei).
  // Dependendo da versão do ethers/rede o preço vem em gasPrice ou effectiveGasPrice (EIP-1559).
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
  // deployment.json fica versionado como registro do deploy (endereço, hash, custo) e é a
  // fonte dos dados preenchidos no README.
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

  // contract.json liga o frontend ao contrato sem copiar nada à mão: endereço, chainId
  // (para detectar rede errada), bloco do deploy (ponto de partida da busca de eventos do
  // histórico) e a ABI, que diz ao ethers quais funções e eventos o contrato possui.
  const artifact = await hre.artifacts.readArtifact("CajuToken");
  const out = path.join(__dirname, "..", "frontend", "src", "contract.json");
  fs.writeFileSync(out, JSON.stringify({ address, chainId: info.chainId, deployBlock: receipt.blockNumber, abi: artifact.abi }, null, 2));
  console.log(`\nEndereço e ABI gravados em frontend/src/contract.json`);

  // Verificação no Etherscan: publica o código-fonte e prova que ele gera exatamente o
  // bytecode implantado, para qualquer pessoa auditar o contrato. Os argumentos do constructor
  // precisam ser os mesmos do deploy. Fica num try/catch porque uma falha aqui (Etherscan lento,
  // chave inválida) não deve invalidar um deploy que já deu certo; o comando manual é impresso.
  if (network.name === "sepolia" && process.env.ETHERSCAN_API_KEY) {
    console.log("\nVerificando no Etherscan...");
    try {
      await hre.run("verify:verify", { address, constructorArguments: [treasury] });
    } catch (err) {
      console.log(`Verificação falhou (rode depois: npx hardhat verify --network sepolia ${address} ${treasury}):`, err.message);
    }
  }
}

// Padrão recomendado pelo Hardhat: em caso de erro, mostra a causa e sai com código 1,
// para que o terminal (ou um CI) saiba que o deploy falhou.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
